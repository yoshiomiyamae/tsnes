// Mapper 70 (Bandai) — UxROM 風 + 8KB CHR バンク（移植元 cppnes `mapper/mapper70.hpp`）。
// バンクレジスタ($8000-$FFFF 書): bit0-3=CHR, bit4-6=PRG, bit7 未使用。
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

export class Mapper70 extends Mapper {
  private prg_bank_ = 0;
  private chr_bank_ = 0;
  private readonly prg_bank_count_: number;
  private readonly chr_bank_count_: number;

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ = Math.floor(data.prg_rom.length / 16384) & 0xff;
    this.chr_bank_count_ = data.chr_rom.length === 0 ? 0 : Math.floor(data.chr_rom.length / 8192) & 0xff;
  }

  read_prg(addr: number): number {
    if (addr >= 0x8000) {
      let bank: number;
      let offset: number;
      if (addr < 0xc000) {
        bank = this.prg_bank_count_ > 0 ? this.prg_bank_ % this.prg_bank_count_ : 0;
        offset = addr - 0x8000;
      } else {
        bank = (this.prg_bank_count_ - 1) & 0xff;
        offset = addr - 0xc000;
      }
      return prg_rom_at(this.data_, bank * 16384 + offset);
    }
    if (addr >= 0x6000) {
      return read_prg_ram(this.data_, addr);
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0x8000) {
      this.chr_bank_ = value & 0x0f;
      this.prg_bank_ = (value >> 4) & 0x07;
      return;
    }
    write_prg_ram(this.data_, addr, value);
  }

  read_chr(addr: number): number {
    if (this.chr_bank_count_ > 0) {
      const bank = this.chr_bank_ % this.chr_bank_count_;
      return chr_rom_at(this.data_, bank * 8192 + addr);
    }
    return read_chr_rom_or_ram(this.data_, addr);
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  save_state(w: StateWriter): void {
    w.u8(this.prg_bank_);
    w.u8(this.chr_bank_);
  }

  load_state(r: StateReader): void {
    this.prg_bank_ = r.u8();
    this.chr_bank_ = r.u8();
  }
}
