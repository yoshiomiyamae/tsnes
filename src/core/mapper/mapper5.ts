// Mapper 5 (MMC5 / ExROM) — Nintendo 最高機能の公式マッパー（移植元 cppnes `mapper/mapper5.hpp`）。
// Castlevania III, Metal Slader Glory 等。PRG/CHR モード、$5105 per-NT ミラー、
// scanline IRQ、8x8 乗算器、ExRAM。
import { type CartridgeData, Mapper, read_chr_rom_or_ram, write_chr_ram } from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

export class Mapper5 extends Mapper {
  private prg_mode_ = 3; // パワーオンは mode 3
  private chr_mode_ = 0;
  private prg_ram_w1_ = 0;
  private prg_ram_w2_ = 0;
  private ex_ram_mode_ = 0;
  private nt_mapping_ = 0;
  private fill_tile_ = 0;
  private fill_attrib_ = 0;
  private readonly prg_banks_ = new Uint8Array(5);
  private readonly chr_a_ = new Uint16Array(8);
  private readonly chr_b_ = new Uint16Array(4);
  private chr_high_ = 0;
  private irq_target_ = 0;
  private irq_enable_ = false;
  private irq_pending_ = false;
  private in_frame_ = false;
  private scanline_ = 0;
  private mult_a_ = 0;
  private mult_b_ = 0;
  private readonly ex_ram_ = new Uint8Array(1024);
  private readonly prg_bank_count_: number;
  private readonly chr_bank_count_: number;
  private sprite8x16_ = false;

  // prg_region() の第 2 戻り値（C++ の std::pair 相当。割り当て回避）。
  private prg_region_size_ = 0;

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ =
      data.prg_rom.length === 0 ? 0 : Math.floor(data.prg_rom.length / 8192) & 0xff;
    this.chr_bank_count_ =
      data.chr_rom.length === 0 ? 0 : Math.floor(data.chr_rom.length / 1024) & 0xffff;
    // reset ベクタが届くよう $5117 を最終 ROM バンクに。
    if (this.prg_bank_count_ > 0) {
      this.prg_banks_[4] = ((this.prg_bank_count_ - 1) | 0x80) & 0xff;
    }
  }

  read_prg(addr: number): number {
    if (addr >= 0x8000) return this.read_mapped_prg(addr);
    if (addr >= 0x6000) {
      const bank = this.prg_banks_[0]! & 0x7f;
      if (this.data_.prg_ram.length === 0) return 0;
      const offset = bank * 8192 + (addr - 0x6000);
      return this.data_.prg_ram[offset % this.data_.prg_ram.length]!;
    }
    if (addr >= 0x5c00) return this.ex_ram_[addr - 0x5c00]!;
    switch (addr) {
      case 0x5204: {
        let v = 0;
        if (this.irq_pending_) v |= 0x80;
        if (this.in_frame_) v |= 0x40;
        this.irq_pending_ = false;
        return v;
      }
      case 0x5205:
        return (this.mult_a_ * this.mult_b_) & 0xff;
      case 0x5206:
        return ((this.mult_a_ * this.mult_b_) >> 8) & 0xff;
      default:
        return 0;
    }
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0x8000) return; // ROM
    if (addr >= 0x6000) {
      if (this.prg_ram_unlocked() && this.data_.prg_ram.length !== 0) {
        const bank = this.prg_banks_[0]! & 0x7f;
        const offset = bank * 8192 + (addr - 0x6000);
        this.data_.prg_ram[offset % this.data_.prg_ram.length] = value;
      }
      return;
    }
    if (addr >= 0x5c00) {
      if (this.ex_ram_mode_ < 3) this.ex_ram_[addr - 0x5c00] = value;
      return;
    }
    this.write_reg(addr, value);
  }

  read_chr(addr: number): number {
    if (this.chr_bank_count_ === 0 || this.data_.chr_rom.length === 0) {
      return read_chr_rom_or_ram(this.data_, addr);
    }
    return this.sprite8x16_ ? this.fetch_chr_from_b_set(addr) : this.fetch_chr_from_a_set(addr);
  }

  read_chr_sprite(addr: number): number {
    if (this.chr_bank_count_ === 0 || this.data_.chr_rom.length === 0) {
      return read_chr_rom_or_ram(this.data_, addr);
    }
    return this.fetch_chr_from_a_set(addr);
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  set_sprite_size(is_8x16: boolean): void {
    this.sprite8x16_ = is_8x16;
  }

  decodes_expansion(): boolean {
    return true;
  }

  notify_scanline(scanline: number, rendering_enabled: boolean): void {
    if (!rendering_enabled) {
      this.in_frame_ = false;
      return;
    }
    if (scanline === 0) {
      this.in_frame_ = true;
      this.scanline_ = 0;
    } else if (this.in_frame_) {
      this.scanline_ = (this.scanline_ + 1) & 0xff;
    }
    if (this.scanline_ === this.irq_target_ && this.irq_target_ !== 0) this.irq_pending_ = true;
  }

  is_irq_pending(): boolean {
    return this.irq_pending_ && this.irq_enable_;
  }
  clear_irq(): void {}
  is_irq_capable(): boolean {
    return true;
  }

  mirroring_mode(): number | null {
    const nt0 = this.nt_mapping_ & 0x03;
    const nt1 = (this.nt_mapping_ >> 2) & 0x03;
    const nt2 = (this.nt_mapping_ >> 4) & 0x03;
    const nt3 = (this.nt_mapping_ >> 6) & 0x03;
    if (nt0 === 0 && nt1 === 0 && nt2 === 1 && nt3 === 1) return 0; // horizontal
    if (nt0 === 0 && nt1 === 1 && nt2 === 0 && nt3 === 1) return 1; // vertical
    if (nt0 === 0 && nt1 === 0 && nt2 === 0 && nt3 === 0) return 2; // single lower
    if (nt0 === 1 && nt1 === 1 && nt2 === 1 && nt3 === 1) return 3; // single upper
    return 1; // 既定近似
  }

  save_state(w: StateWriter): void {
    w.u8(this.prg_mode_);
    w.u8(this.chr_mode_);
    w.u8(this.prg_ram_w1_);
    w.u8(this.prg_ram_w2_);
    w.u8(this.ex_ram_mode_);
    w.u8(this.nt_mapping_);
    w.u8(this.fill_tile_);
    w.u8(this.fill_attrib_);
    w.u8(this.chr_high_);
    w.bytes(this.prg_banks_);
    for (const v of this.chr_a_) w.u16(v);
    for (const v of this.chr_b_) w.u16(v);
    w.u8(this.irq_target_);
    w.boolean(this.irq_enable_);
    w.boolean(this.irq_pending_);
    w.boolean(this.in_frame_);
    w.u8(this.scanline_);
    w.u8(this.mult_a_);
    w.u8(this.mult_b_);
    w.bytes(this.ex_ram_);
  }

  load_state(r: StateReader): void {
    this.prg_mode_ = r.u8();
    this.chr_mode_ = r.u8();
    this.prg_ram_w1_ = r.u8();
    this.prg_ram_w2_ = r.u8();
    this.ex_ram_mode_ = r.u8();
    this.nt_mapping_ = r.u8();
    this.fill_tile_ = r.u8();
    this.fill_attrib_ = r.u8();
    this.chr_high_ = r.u8();
    r.read_into(this.prg_banks_);
    for (let i = 0; i < this.chr_a_.length; i++) this.chr_a_[i] = r.u16();
    for (let i = 0; i < this.chr_b_.length; i++) this.chr_b_[i] = r.u16();
    this.irq_target_ = r.u8();
    this.irq_enable_ = r.boolean();
    this.irq_pending_ = r.boolean();
    this.in_frame_ = r.boolean();
    this.scanline_ = r.u8();
    this.mult_a_ = r.u8();
    this.mult_b_ = r.u8();
    r.read_into(this.ex_ram_);
  }

  private prg_ram_unlocked(): boolean {
    return (this.prg_ram_w1_ & 0x03) === 0x02 && (this.prg_ram_w2_ & 0x03) === 0x01;
  }

  // 領域番号を返し、バンクサイズは prg_region_size_ に置く（C++ の pair 相当）。
  private prg_region(addr: number): number {
    switch (this.prg_mode_) {
      case 0:
        this.prg_region_size_ = 32768;
        return 4;
      case 1:
        this.prg_region_size_ = 16384;
        return addr < 0xc000 ? 2 : 4;
      case 2:
        if (addr < 0xc000) {
          this.prg_region_size_ = 16384;
          return 2;
        }
        this.prg_region_size_ = 8192;
        return addr < 0xe000 ? 3 : 4;
      default:
        this.prg_region_size_ = 8192;
        if (addr < 0xa000) return 1;
        if (addr < 0xc000) return 2;
        if (addr < 0xe000) return 3;
        return 4;
    }
  }

  private prg_region_base(region: number, size: number): number {
    if (size === 32768) return 0x8000;
    if (size === 16384) return region === 2 ? 0x8000 : 0xc000;
    switch (region) {
      case 1: return 0x8000;
      case 2: return 0xa000;
      case 3: return 0xc000;
      default: return 0xe000;
    }
  }

  private read_mapped_prg(addr: number): number {
    const region = this.prg_region(addr);
    const bank_size = this.prg_region_size_;
    const raw = this.prg_banks_[region]!;
    let is_rom = (raw & 0x80) !== 0;
    if (region === 4) is_rom = true; // $5117 は常に ROM
    let bank = raw & 0x7f;
    if (bank_size === 16384) bank = bank & 0xfe;
    else if (bank_size === 32768) bank = bank & 0xfc;
    const offset = bank * 8192 + (addr - this.prg_region_base(region, bank_size));
    if (!is_rom) {
      if (this.data_.prg_ram.length === 0) return 0;
      return this.data_.prg_ram[offset % this.data_.prg_ram.length]!;
    }
    if (this.prg_bank_count_ === 0) return 0;
    const mask = this.prg_bank_count_ * 8192 - 1;
    return this.data_.prg_rom[offset & mask]!;
  }

  private write_reg(addr: number, value: number): void {
    switch (addr) {
      case 0x5100: this.prg_mode_ = value & 0x03; break;
      case 0x5101: this.chr_mode_ = value & 0x03; break;
      case 0x5102: this.prg_ram_w1_ = value; break;
      case 0x5103: this.prg_ram_w2_ = value; break;
      case 0x5104: this.ex_ram_mode_ = value & 0x03; break;
      case 0x5105: this.nt_mapping_ = value; break;
      case 0x5106: this.fill_tile_ = value; break;
      case 0x5107: this.fill_attrib_ = value & 0x03; break;
      case 0x5113: this.prg_banks_[0] = value; break;
      case 0x5114:
      case 0x5115:
      case 0x5116:
      case 0x5117:
        this.prg_banks_[1 + (addr - 0x5114)] = value;
        break;
      case 0x5130: this.chr_high_ = value & 0x03; break;
      case 0x5203: this.irq_target_ = value; break;
      case 0x5204: this.irq_enable_ = (value & 0x80) !== 0; break;
      case 0x5205: this.mult_a_ = value; break;
      case 0x5206: this.mult_b_ = value; break;
      default:
        if (addr >= 0x5120 && addr <= 0x5127) {
          this.chr_a_[addr - 0x5120] = (value | (this.chr_high_ << 8)) & 0xffff;
        } else if (addr >= 0x5128 && addr <= 0x512b) {
          this.chr_b_[addr - 0x5128] = (value | (this.chr_high_ << 8)) & 0xffff;
        }
        break;
    }
  }

  private fetch_chr_from_a_set(addr: number): number {
    let bank: number;
    let in_bank: number;
    switch (this.chr_mode_) {
      case 0:
        bank = this.chr_a_[7]! * 8;
        in_bank = addr & 0x1fff;
        break;
      case 1: {
        const idx = addr & 0x1000 ? 7 : 3;
        bank = this.chr_a_[idx]! * 4;
        in_bank = addr & 0x0fff;
        break;
      }
      case 2: {
        const idx = ((addr >> 11) & 0x03) * 2 + 1;
        bank = this.chr_a_[idx]! * 2;
        in_bank = addr & 0x07ff;
        break;
      }
      default: {
        const idx = (addr >> 10) & 0x07;
        bank = this.chr_a_[idx]!;
        in_bank = addr & 0x03ff;
        break;
      }
    }
    const final_addr = (bank * 1024 + in_bank) % this.data_.chr_rom.length;
    return this.data_.chr_rom[final_addr]!;
  }

  private fetch_chr_from_b_set(addr: number): number {
    let bank: number;
    let in_bank: number;
    switch (this.chr_mode_) {
      case 0:
        bank = this.chr_b_[3]! * 8;
        in_bank = addr & 0x1fff;
        break;
      case 1:
        bank = this.chr_b_[3]! * 4;
        in_bank = addr & 0x0fff;
        break;
      case 2: {
        const idx = ((addr >> 11) & 0x01) * 2 + 1;
        bank = this.chr_b_[idx]! * 2;
        in_bank = addr & 0x07ff;
        break;
      }
      default: {
        const idx = (addr >> 10) & 0x03;
        bank = this.chr_b_[idx]!;
        in_bank = addr & 0x03ff;
        break;
      }
    }
    const final_addr = (bank * 1024 + in_bank) % this.data_.chr_rom.length;
    return this.data_.chr_rom[final_addr]!;
  }
}
