// Mapper 1 (MMC1) — シリアルポートマッパー（移植元 cppnes `mapper/mapper1.hpp`）。
import {
  type CartridgeData,
  Mapper,
  chr_rom_at,
  prg_rom_at,
  read_chr_rom_or_ram,
  read_prg_ram,
  write_chr_ram,
  write_prg_ram,
} from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

// MMC1。5 ビットシリアルシフトレジスタで内部レジスタを設定する。
export class Mapper1 extends Mapper {
  private shift_register_ = 0;
  private shift_count_ = 0;
  private control_ = 0x0c; // 既定: PRG mode 3, CHR mode 0
  private chr_bank0_ = 0;
  private chr_bank1_ = 0;
  private prg_bank_ = 0;
  private prg_mode_ = 3;
  private chr_mode_ = 0;
  private mirroring_ = 0;
  // PRG mode 3 の $C000 固定バンク。ROM サイズは不変なので構築時に 1 度だけ求める。
  private readonly last_prg_bank_: number;

  constructor(data: CartridgeData) {
    super(data);
    this.last_prg_bank_ =
      data.prg_rom.length >= 0x4000 ? Math.floor(data.prg_rom.length / 0x4000) - 1 : 0;
  }

  read_prg(addr: number): number {
    if (addr >= 0x8000) {
      const a = addr - 0x8000;
      let offset: number;
      switch (this.prg_mode_) {
        case 0:
        case 1: {
          // 32KB モード
          const bank = this.prg_bank_ >> 1;
          offset = bank * 0x8000 + a;
          break;
        }
        case 2: // 16KB、$8000 に第 0 バンク固定
          if (a < 0x4000) {
            offset = a;
          } else {
            const bank = this.prg_bank_ & 0x0f;
            offset = bank * 0x4000 + (a - 0x4000);
          }
          break;
        default: {
          // mode 3: 16KB、$C000 に最終バンク固定
          if (a < 0x4000) {
            const bank = this.prg_bank_ & 0x0f;
            offset = bank * 0x4000 + a;
          } else {
            offset = this.last_prg_bank_ * 0x4000 + (a - 0x4000);
          }
          break;
        }
      }
      return prg_rom_at(this.data_, offset);
    }
    if (addr >= 0x6000 && (this.prg_bank_ & 0x10) === 0) {
      return read_prg_ram(this.data_, addr);
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0x8000) {
      if (value & 0x80) {
        // シフトレジスタリセット
        this.shift_register_ = 0;
        this.shift_count_ = 0;
        this.control_ = (this.control_ | 0x0c) & 0xff;
        this.prg_mode_ = 3;
      } else {
        this.shift_register_ = ((this.shift_register_ >> 1) | ((value & 1) << 4)) & 0xff;
        this.shift_count_++;
        if (this.shift_count_ === 5) {
          this.write_register(addr, this.shift_register_);
          this.shift_register_ = 0;
          this.shift_count_ = 0;
        }
      }
    } else if (addr >= 0x6000 && (this.prg_bank_ & 0x10) === 0) {
      write_prg_ram(this.data_, addr, value);
    }
  }

  read_chr(addr: number): number {
    if (this.data_.chr_rom.length !== 0) {
      let offset: number;
      if (this.chr_mode_ === 0) {
        // 8KB モード
        offset = (this.chr_bank0_ >> 1) * 0x2000 + addr;
      } else if (addr < 0x1000) {
        offset = this.chr_bank0_ * 0x1000 + addr;
      } else {
        offset = this.chr_bank1_ * 0x1000 + (addr - 0x1000);
      }
      return chr_rom_at(this.data_, offset);
    }
    return read_chr_rom_or_ram(this.data_, addr);
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  // MMC1 control bit0-1 を PPU ミラーリングコードへ変換する。
  mirroring_mode(): number | null {
    switch (this.mirroring_ & 3) {
      case 0: return 2; // single-screen lower
      case 1: return 3; // single-screen upper
      case 2: return 1; // vertical
      default: return 0; // horizontal
    }
  }

  save_state(w: StateWriter): void {
    w.u8(this.shift_register_);
    w.u8(this.shift_count_);
    w.u8(this.control_);
    w.u8(this.chr_bank0_);
    w.u8(this.chr_bank1_);
    w.u8(this.prg_bank_);
    w.u8(this.prg_mode_);
    w.u8(this.chr_mode_);
    w.u8(this.mirroring_);
  }

  load_state(r: StateReader): void {
    this.shift_register_ = r.u8();
    this.shift_count_ = r.u8();
    this.control_ = r.u8();
    this.chr_bank0_ = r.u8();
    this.chr_bank1_ = r.u8();
    this.prg_bank_ = r.u8();
    this.prg_mode_ = r.u8();
    this.chr_mode_ = r.u8();
    this.mirroring_ = r.u8();
  }

  private write_register(addr: number, value: number): void {
    if (addr <= 0x9fff) {
      // Control
      this.control_ = value;
      this.mirroring_ = value & 3;
      this.prg_mode_ = (value >> 2) & 3;
      this.chr_mode_ = (value >> 4) & 1;
    } else if (addr <= 0xbfff) {
      this.chr_bank0_ = value;
    } else if (addr <= 0xdfff) {
      this.chr_bank1_ = value;
    } else {
      this.prg_bank_ = value;
    }
  }
}
