// システムバス（移植元 cppnes `bus.hpp` / `bus.cpp`）。
//
// CPU から見たメモリマップ全体を担う。Bus が RAM・PPU・APU・Cartridge・Input・
// Cheat を所有し、CPU の R/W をアドレスで振り分ける（中央集権 Bus パターン）。
// PPU/APU は CHR/ミラーリング/IRQ のため Cartridge を引数で受け取る
// （C++ の `Cartridge*` に対応。未接続は null）。
import { Apu } from "./apu.ts";
import type { Cartridge } from "./cartridge.ts";
import { CheatManager } from "./cheat.ts";
import { Controller } from "./input.ts";
import { Ppu } from "./ppu.ts";
import type { StateReader, StateWriter } from "./savestate.ts";

// OAM DMA（STA $4014）が通常の命令サイクルに上乗せする CPU ストールサイクル数。
// 1（ダミー/整列）+ 256（読み）+ 256（書き）。
export const OAM_DMA_STALL_CYCLES = 513;

export class Bus {
  // CPU 作業 RAM（2KB）。$0000-$1FFF に 0x800 ごとミラーされる。
  readonly ram = new Uint8Array(2048);

  readonly ppu = new Ppu();
  readonly apu = new Apu();
  cartridge: Cartridge | null = null;
  // コントローラ 2 個（[0]=1P/$4016, [1]=2P/$4017）。
  readonly input: [Controller, Controller] = [new Controller(), new Controller()];
  // 読み出し時チートパッチャ（Game Genie / raw poke）。
  readonly cheats = new CheatManager();

  // カートリッジ未接続時の $6000-$FFFF バッキング（テスト用）。
  private readonly high_mem_ = new Uint8Array(0xa000);

  // CPU データバスに最後に乗ったバイト（open-bus）。バスを駆動しないアドレスは
  // 0 ではなくこの値を返す。
  private cpu_bus_ = 0;

  // 一時 OAM DMA バッファ（毎回の割り当てを避ける）。
  private readonly dma_buf_ = new Uint8Array(256);

  // カートリッジを接続し、PPU にミラーリング等を反映する。
  set_cartridge(cart: Cartridge): void {
    this.cartridge = cart;
    this.ppu.attach_cartridge(cart);
  }

  // 装着中カートリッジ（未接続は null）。PPU/APU へ渡す。
  cart_ptr(): Cartridge | null {
    return this.cartridge;
  }

  // 1 バイト読み出す。チートパッチャ設定時は元領域の値に上書きを適用する。
  read(addr: number): number {
    const v = this.read_inner(addr);
    if (this.cheats.is_empty()) {
      return v;
    }
    return this.cheats.apply(addr, v);
  }

  // パッチ前の生読み出し。バスを駆動した読みはすべて cpu_bus_ にラッチする。
  private read_inner(addr: number): number {
    if (addr < 0x2000) {
      const v = this.ram[addr & 0x7ff]!;
      this.cpu_bus_ = v;
      return v;
    }

    if (addr >= 0x6000) {
      if (this.cartridge !== null) {
        const v = this.cartridge.read_prg(addr);
        this.cpu_bus_ = v;
        return v;
      }
      const v = this.high_mem_[addr - 0x6000]!;
      this.cpu_bus_ = v;
      return v;
    }

    if (addr < 0x4000) {
      // PPU レジスタ（$2000-$3FFF、8 バイトごとミラー）。
      const v = this.ppu.read_register(0x2000 + (addr & 0x7), this.cartridge);
      this.cpu_bus_ = v;
      return v;
    }

    if (addr === 0x4015) {
      const v = this.apu.read_register(addr);
      this.cpu_bus_ = v;
      return v;
    }

    if (addr === 0x4016) {
      // bit0 は 1P コントローラ、bit1-7 は実機では open bus。
      const v = ((this.cpu_bus_ & 0xfe) | (this.input[0].read() & 0x01)) & 0xff;
      this.cpu_bus_ = v;
      return v;
    }

    if (addr === 0x4017) {
      // 読み: 2P コントローラ（書きは APU フレームカウンタ）。
      const v = ((this.cpu_bus_ & 0xfe) | (this.input[1].read() & 0x01)) & 0xff;
      this.cpu_bus_ = v;
      return v;
    }

    // $4000-$4014 は書き込み専用 APU ポート、$4018-$401F は CPU テスト/未割り当て。
    // すべて open bus。
    if (addr < 0x4020) {
      return this.cpu_bus_;
    }

    // $4020-$5FFF はカートリッジ拡張。opt-in マッパー(MMC5)のみデコードし、
    // それ以外は open bus のまま。
    if (this.cartridge !== null && this.cartridge.has_expansion()) {
      const v = this.cartridge.read_prg(addr);
      this.cpu_bus_ = v;
      return v;
    }
    return this.cpu_bus_;
  }

  // 1 バイト書き込む。戻り値は命令の通常サイクルに上乗せされる CPU ストール
  // サイクル数で、OAM DMA（$4014）以外は 0。
  write(addr: number, value: number): number {
    this.cpu_bus_ = value;

    if (addr < 0x2000) {
      // CPU RAM（0x800 ごとミラー）
      this.ram[addr % 0x800] = value;
    } else if (addr < 0x4000) {
      // PPU レジスタ（8 バイトごとミラー）
      this.ppu.write_register(0x2000 + (addr & 0x7), value, this.cartridge);
    } else if (addr === 0x4014) {
      this.perform_oam_dma(value);
      return OAM_DMA_STALL_CYCLES;
    } else if (addr === 0x4016) {
      // ストローブは両コントローラへ。
      this.input[0].write(value);
      this.input[1].write(value);
    } else if (addr < 0x4020) {
      this.apu.write_register(addr, value);
    } else if (addr < 0x6000) {
      // カートリッジ拡張（$4020-$5FFF）。opt-in マッパー(MMC5)のみ受信。
      if (this.cartridge !== null && this.cartridge.has_expansion()) {
        this.cartridge.write_prg(addr, value);
      }
    } else {
      // addr >= 0x6000
      if (this.cartridge !== null) {
        this.cartridge.write_prg(addr, value);
      } else {
        const index = addr - 0x6000;
        if (index < 0xa000) {
          this.high_mem_[index] = value;
        }
      }
    }
    return 0;
  }

  // OAM DMA。CPU メモリの 1 ページ(256B)を PPU OAM へ転送する。
  private perform_oam_dma(page: number): void {
    const base = (page << 8) & 0xffff;
    const buf = this.dma_buf_;
    for (let i = 0; i < 256; i++) {
      buf[i] = this.read((base + i) & 0xffff);
    }
    for (let i = 0; i < 256; i++) {
      this.ppu.write_register(0x2004, buf[i]!, this.cartridge);
    }
  }

  // CPU 作業 RAM（2KB）を書き出す / 読み戻す。
  save_state(w: StateWriter): void {
    w.bytes(this.ram);
  }

  load_state(r: StateReader): void {
    r.read_into(this.ram);
  }
}
