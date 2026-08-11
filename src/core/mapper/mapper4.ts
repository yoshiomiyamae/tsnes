// Mapper 4 (MMC3) — バンク切替 + A12 スキャンライン IRQ（移植元 cppnes `mapper/mapper4.hpp`）。
//
// IRQ カウンタは 2 経路でクロックされる:
//   - step(): PPU の per-scanline A12 立ち上がりティック。
//   - notify_a12(): CPU 駆動の $2006/$2007 アクセスでの A12 0→1（mmc3_test がこの経路）。
import { type CartridgeData, Mapper, prg_rom_at } from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

export interface IrqState {
  counter: number;
  reload: number;
  enabled: boolean;
  pending: boolean;
}

export class Mapper4 extends Mapper {
  private readonly bank_registers_ = new Uint8Array(8);
  private bank_select_ = 0;
  private mirror_mode_ = 0;
  private prg_ram_protect_ = 0x80;
  private irq_reload_value_ = 0;
  private irq_counter_ = 0;
  private irq_enabled_ = false;
  private irq_pending_ = false;
  private irq_reload_flag_ = false;
  private last_a12_high_ = false;
  private readonly prg_bank_count_: number;
  private readonly chr_bank_count_: number;
  private readonly chr_window_offset_ = new Uint32Array(8);
  // $8000/$A000/$C000/$E000 の 8KB 窓ごとの PRG オフセット。CHR と同様、
  // バンクレジスタ書き込み時にだけ再計算する。
  private readonly prg_window_offset_ = new Uint32Array(4);
  // recalc_banks の作業用（呼び出し毎の配列確保を避ける）。
  private readonly bank_scratch_ = new Uint8Array(8);

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ = Math.floor(data.prg_rom.length / 8192) & 0xff;
    if (data.chr_rom.length !== 0) {
      this.chr_bank_count_ = Math.floor(data.chr_rom.length / 1024) & 0xff;
    } else if (data.chr_ram.length !== 0) {
      this.chr_bank_count_ = Math.floor(data.chr_ram.length / 1024) & 0xff;
    } else {
      this.chr_bank_count_ = 8;
    }
    if (this.prg_bank_count_ >= 2) {
      this.bank_registers_[6] = (this.prg_bank_count_ - 2) & 0xff;
      this.bank_registers_[7] = (this.prg_bank_count_ - 1) & 0xff;
    }
    for (let i = 0; i < 6; i++) {
      this.bank_registers_[i] = this.chr_bank_count_ > 0 ? i % this.chr_bank_count_ : i;
    }
    this.recalc_banks();
  }

  read_prg(addr: number): number {
    if (addr >= 0x6000 && addr <= 0x7fff) {
      if (this.data_.prg_ram.length !== 0 && this.prg_ram_protect_ & 0x80) {
        return this.data_.prg_ram[addr - 0x6000] ?? 0;
      }
      return 0;
    }
    if (addr >= 0x8000) {
      return prg_rom_at(this.data_, this.prg_window_offset_[(addr >> 13) & 3]! + (addr & 0x1fff));
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0x6000 && addr <= 0x7fff) {
      if (
        this.data_.prg_ram.length !== 0 &&
        this.prg_ram_protect_ & 0x80 &&
        (this.prg_ram_protect_ & 0x40) === 0
      ) {
        this.data_.prg_ram[addr - 0x6000] = value;
      }
      return;
    }
    if (addr < 0x8000) return;
    switch (addr & 0xe001) {
      case 0x8000:
        this.bank_select_ = value;
        this.recalc_banks();
        break;
      case 0x8001: {
        const reg = this.bank_select_ & 0x07;
        if (reg >= 6) {
          this.bank_registers_[reg] =
            this.prg_bank_count_ > 0 ? value % this.prg_bank_count_ : value;
        } else {
          this.bank_registers_[reg] =
            this.chr_bank_count_ > 0 ? value % this.chr_bank_count_ : value;
        }
        this.recalc_banks();
        break;
      }
      case 0xa000:
        this.mirror_mode_ = value & 1;
        break;
      case 0xa001:
        this.prg_ram_protect_ = value;
        break;
      case 0xc000:
        this.irq_reload_value_ = value;
        break;
      case 0xc001:
        this.irq_reload_flag_ = true;
        this.irq_counter_ = 0;
        break;
      case 0xe000:
        this.irq_enabled_ = false;
        this.irq_pending_ = false;
        break;
      case 0xe001:
        this.irq_enabled_ = true;
        break;
      default:
        break;
    }
  }

  read_chr(addr: number): number {
    if (addr >= 0x2000) return 0;
    const offset = this.chr_window_offset_[addr >> 10]! + (addr & 0x3ff);
    if (offset < this.data_.chr_rom.length) return this.data_.chr_rom[offset]!;
    if (offset < this.data_.chr_ram.length) return this.data_.chr_ram[offset]!;
    return 0;
  }

  write_chr(addr: number, value: number): void {
    if (addr >= 0x2000 || this.data_.chr_ram.length === 0) return;
    const offset = this.chr_window_offset_[addr >> 10]! + (addr & 0x3ff);
    if (offset < this.data_.chr_ram.length) this.data_.chr_ram[offset] = value;
  }

  step(): void {
    this.clock_irq();
    this.last_a12_high_ = false;
  }

  is_irq_pending(): boolean {
    return this.irq_pending_;
  }
  clear_irq(): void {
    this.irq_pending_ = false;
  }
  is_irq_capable(): boolean {
    return true;
  }
  mirroring_mode(): number | null {
    return this.get_mirroring_mode();
  }

  notify_a12(chr_addr: number, _rendering_enabled: boolean): void {
    const new_a12 = (chr_addr & 0x1000) !== 0;
    if (new_a12 && !this.last_a12_high_) this.clock_irq();
    this.last_a12_high_ = new_a12;
  }

  save_state(w: StateWriter): void {
    w.bytes(this.bank_registers_);
    w.u8(this.bank_select_);
    w.u8(this.mirror_mode_);
    w.u8(this.prg_ram_protect_);
    w.u8(this.irq_reload_value_);
    w.u8(this.irq_counter_);
    w.boolean(this.irq_enabled_);
    w.boolean(this.irq_pending_);
    w.boolean(this.irq_reload_flag_);
    w.boolean(this.last_a12_high_);
  }

  load_state(r: StateReader): void {
    r.read_into(this.bank_registers_);
    this.bank_select_ = r.u8();
    this.mirror_mode_ = r.u8();
    this.prg_ram_protect_ = r.u8();
    this.irq_reload_value_ = r.u8();
    this.irq_counter_ = r.u8();
    this.irq_enabled_ = r.boolean();
    this.irq_pending_ = r.boolean();
    this.irq_reload_flag_ = r.boolean();
    this.last_a12_high_ = r.boolean();
    this.recalc_banks();
  }

  // テスト用アクセサ。
  irq_state(): IrqState {
    return {
      counter: this.irq_counter_,
      reload: this.irq_reload_value_,
      enabled: this.irq_enabled_,
      pending: this.irq_pending_,
    };
  }

  get_mirroring_mode(): number {
    return this.mirror_mode_ === 0 ? 1 : 0;
  }

  // バンクレジスタ変更時に PRG/CHR の窓オフセットを再計算する
  // （C++ は PRG を読み毎に解決するが、入力が変わるのは $8000/$8001 書き込み時だけ）。
  private recalc_banks(): void {
    // ---- PRG（8KB × 4 窓）----
    const prg_mode = (this.bank_select_ >> 6) & 1;
    const second_last = (this.prg_bank_count_ - 2) & 0xff;
    const last = (this.prg_bank_count_ - 1) & 0xff;
    const prg = this.bank_scratch_;
    prg[0] = prg_mode === 0 ? this.bank_registers_[6]! : second_last; // $8000-$9FFF
    prg[1] = this.bank_registers_[7]!; // $A000-$BFFF
    prg[2] = prg_mode === 0 ? second_last : this.bank_registers_[6]!; // $C000-$DFFF
    prg[3] = last; // $E000-$FFFF
    for (let w = 0; w < 4; w++) {
      const bank = prg[w]! >= this.prg_bank_count_ ? last : prg[w]!;
      this.prg_window_offset_[w] = bank * 0x2000;
    }

    // ---- CHR（1KB × 8 窓）----
    const banks = this.bank_scratch_;
    const r0 = this.bank_registers_[0]! & 0xfe;
    const r1 = this.bank_registers_[1]! & 0xfe;
    if (((this.bank_select_ >> 7) & 1) === 0) {
      // Mode 0: $0000 = R0,R1(2KB); $1000 = R2..R5(1KB)
      banks[0] = r0;
      banks[1] = r0 + 1;
      banks[2] = r1;
      banks[3] = r1 + 1;
      banks[4] = this.bank_registers_[2]!;
      banks[5] = this.bank_registers_[3]!;
      banks[6] = this.bank_registers_[4]!;
      banks[7] = this.bank_registers_[5]!;
    } else {
      // Mode 1: $0000 = R2..R5(1KB); $1000 = R0,R1(2KB)
      banks[0] = this.bank_registers_[2]!;
      banks[1] = this.bank_registers_[3]!;
      banks[2] = this.bank_registers_[4]!;
      banks[3] = this.bank_registers_[5]!;
      banks[4] = r0;
      banks[5] = r0 + 1;
      banks[6] = r1;
      banks[7] = r1 + 1;
    }
    for (let w = 0; w < 8; w++) {
      const b = this.chr_bank_count_ > 0 ? banks[w]! % this.chr_bank_count_ : banks[w]!;
      this.chr_window_offset_[w] = b * 0x400;
    }
  }

  private clock_irq(): void {
    if (this.irq_reload_flag_ || this.irq_counter_ === 0) {
      this.irq_counter_ = this.irq_reload_value_;
      this.irq_reload_flag_ = false;
    } else {
      this.irq_counter_ = (this.irq_counter_ - 1) & 0xff;
    }
    if (this.irq_counter_ === 0 && this.irq_enabled_) {
      this.irq_pending_ = true;
    }
  }
}
