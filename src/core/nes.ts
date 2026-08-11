// NES 全体統合（移植元 cppnes `nes.hpp` / `nes.cpp`）。
//
// Nes が cpu と bus を別フィールドで所有し、cpu.step(bus) と駆動する。Bus が
// PPU/APU/Cartridge を所有するので、step ループは bus.ppu / bus.cart_ptr() 等を
// 介して各コンポーネントを駆動する。
import { Bus } from "./bus.ts";
import { Cartridge } from "./cartridge.ts";
import { Cpu } from "./cpu.ts";
import {
  STATE_MAGIC,
  STATE_VERSION,
  StateError,
  StateErrorKind,
  StateReader,
  StateWriter,
} from "./savestate.ts";

const EMPTY = new Uint8Array(0);

export class Nes {
  readonly cpu = new Cpu();
  readonly bus = new Bus();

  cycles = 0;
  frame = 0;

  // NMI 配送パイプライン（nmi_delay → pending_nmi → CPU.nmi）。
  private nmi_delay_ = false;
  private pending_nmi_ = false;
  // カートリッジが CPU IRQ ラインをアサートし得るか。
  private cart_has_irq_ = false;

  // カートリッジを装着する。
  load_cartridge(cart: Cartridge): void {
    this.cart_has_irq_ = cart.has_irq();
    this.bus.set_cartridge(cart);
  }

  // iNES バイト列からカートリッジを読み込んで装着し、電源投入リセットする。
  static power_on_from_rom(rom: Uint8Array): Nes {
    const cart = Cartridge.from_bytes(rom);
    const nes = new Nes();
    nes.load_cartridge(cart);
    nes.reset();
    return nes;
  }

  reset(): void {
    this.cpu.reset(this.bus);
    this.bus.ppu.reset();
    this.bus.apu.reset();
    this.cycles = 0;
    this.frame = 0;
    this.nmi_delay_ = false;
    this.pending_nmi_ = false;
  }

  // リセットボタン（CPU の I/SP のみ、RAM 保持）。
  soft_reset(): void {
    this.cpu.soft_reset(this.bus);
    this.bus.ppu.reset();
    this.bus.apu.reset();
    this.nmi_delay_ = false;
    this.pending_nmi_ = false;
  }

  // 1 CPU 命令分実行し、PPU/APU/マッパーを同期させる。
  step(): void {
    const cpu_cycles = this.cpu.step(this.bus);

    // CPU.step 内で $2000 書きにより即時 NMI がアサートされた場合を捕捉。
    const immediate_nmi = this.bus.ppu.consume_nmi();

    // 直前命令が $E000（MMC3 IRQ ack）を書いた可能性 → キャッシュ更新。
    if (this.cart_has_irq_) {
      const c = this.bus.cart_ptr();
      if (c !== null) {
        this.bus.ppu.mapper_irq = c.is_irq_pending();
      }
    }

    // NMI 配送パイプライン（各段 1 step 進む）。
    if (this.pending_nmi_) {
      this.cpu.trigger_nmi();
      this.pending_nmi_ = false;
    }
    if (this.nmi_delay_) {
      this.pending_nmi_ = true;
      this.nmi_delay_ = false;
    }
    if (immediate_nmi) {
      this.pending_nmi_ = true;
    }

    // PPU を CPU サイクル ×3 進める。
    this.bus.ppu.step_n(cpu_cycles * 3, this.bus.cart_ptr());

    // catch-up 中に VBL がセットされ NMI がアサートされたら次段へ。
    if (this.bus.ppu.consume_nmi()) {
      this.nmi_delay_ = true;
    }

    this.bus.apu.step_n(cpu_cycles, this.bus.cart_ptr());

    // CPU レートのマッパータイマ（FME-7）。
    {
      const c = this.bus.cart_ptr();
      if (c !== null) {
        c.tick_cpu(cpu_cycles);
        if (this.cart_has_irq_) {
          this.bus.ppu.mapper_irq = c.is_irq_pending();
        }
      }
    }

    // レベルトリガ IRQ — 6502 の IRQ 入力に繋がる全ラインを OR する。
    this.cpu.irq =
      this.bus.ppu.mapper_irq || this.bus.apu.frame_irq || this.bus.apu.dmc.interrupt_flag;

    // バスが追いついた後で、今完了した命令の末尾 IRQ ポールを実行する。
    this.cpu.poll_irq();

    this.cycles += cpu_cycles;
  }

  // フレーム完了まで実行する。
  step_frame(): void {
    let steps = 0;
    const MAX_STEPS = 50000; // フリーズ時の無限ループ防止
    while (!this.bus.ppu.frame_complete) {
      this.step();
      if (++steps > MAX_STEPS) {
        this.bus.ppu.frame_complete = true;
        break;
      }
    }
    this.bus.ppu.frame_complete = false;
    this.frame = this.bus.ppu.frame;
  }

  // 現在のフレームバッファ（ARGB）。
  framebuffer(): Uint32Array {
    return this.bus.ppu.frame_buffer;
  }

  // ---- バッテリー RAM（.sav）----
  has_battery(): boolean {
    return this.bus.cartridge !== null && this.bus.cartridge.has_battery();
  }

  battery_ram(): Uint8Array {
    return this.bus.cartridge !== null ? this.bus.cartridge.save_ram() : EMPTY;
  }

  load_battery_ram(data: Uint8Array): void {
    if (this.bus.cartridge !== null) {
      this.bus.cartridge.load_ram(data);
    }
  }

  // コントローラのボタン状態（player 0=1P/1=2P、button はビット 0-7）。
  set_button(player: number, button: number, pressed: boolean): void {
    this.bus.input[player & 1]!.set_button(0, button, pressed);
  }

  // ---- チート（.cht）----
  // `.cht` テキストを読み込んでチートを登録する。戻りはパースエラー一覧。
  load_cheats_str(text: string): string[] {
    return this.bus.cheats.load_str(text);
  }

  // ---- セーブステート（cppnes / rsnes と同形式）----
  save_state(): Uint8Array {
    const w = new StateWriter();
    w.u32(STATE_MAGIC);
    w.u32(STATE_VERSION);
    this.cpu.save_state(w);
    this.bus.ppu.save_state(w);
    this.bus.apu.save_state(w);
    w.bytes(this.bus.ram);
    if (this.bus.cartridge !== null) {
      w.u8(1);
      this.bus.cartridge.save_state(w);
    } else {
      w.u8(0);
    }
    w.boolean(this.nmi_delay_);
    w.boolean(this.pending_nmi_);
    return w.into_bytes();
  }

  load_state(data: Uint8Array): void {
    const r = new StateReader(data);
    if (r.u32() !== STATE_MAGIC) throw new StateError(StateErrorKind.BadMagic);
    if (r.u32() !== STATE_VERSION) throw new StateError(StateErrorKind.VersionMismatch);

    this.cpu.load_state(r);
    this.bus.ppu.load_state(r);
    this.bus.apu.load_state(r);
    r.read_into(this.bus.ram);

    const has_cart = r.u8();
    if (has_cart === 1 && this.bus.cartridge !== null) {
      this.bus.cartridge.load_state(r);
    }
    this.nmi_delay_ = r.boolean();
    this.pending_nmi_ = r.boolean();

    // PPUCTRL bit5（8×16）を MMC5 CHR ルーティングへ再通知（ライブ $2000 経路と同じ）。
    const is_8x16 = (this.bus.ppu.ppuctrl & 0x20) !== 0;
    if (this.bus.cartridge !== null) {
      this.bus.cartridge.set_sprite_size(is_8x16);
    }
  }
}
