// Mapper 2 (UxROM) — 16KB PRG バンク切替、CHR RAM（移植元 cppnes `mapper/mapper2.hpp`）。
import {
  type CartridgeData,
  Mapper,
  prg_rom_at,
  read_chr_rom_or_ram,
  read_prg_ram,
  write_chr_ram,
  write_prg_ram,
} from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

// UxROM。$8000-$BFFF が切替バンク、$C000-$FFFF は最終バンク固定。
export class Mapper2 extends Mapper {
  private prg_bank_ = 0;
  private readonly prg_bank_count_: number;

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ = Math.floor(data.prg_rom.length / 16384) & 0xff;
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
      this.prg_bank_ = value & 0x0f;
      return;
    }
    write_prg_ram(this.data_, addr, value);
  }

  read_chr(addr: number): number {
    return read_chr_rom_or_ram(this.data_, addr);
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  save_state(w: StateWriter): void {
    w.u8(this.prg_bank_);
  }

  load_state(r: StateReader): void {
    this.prg_bank_ = r.u8();
  }
}
