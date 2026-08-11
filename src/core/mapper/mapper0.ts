// Mapper 0 (NROM) — バンク切替なし（移植元 cppnes `mapper/mapper0.hpp` / `mapper0.cpp`）。
import {
  Mapper,
  read_chr_rom_or_ram,
  read_prg_ram,
  write_chr_ram,
  write_prg_ram,
} from "../mapper.ts";

// NROM。16KB PRG は $C000 へミラー、32KB PRG はそのまま。
export class Mapper0 extends Mapper {
  read_prg(addr: number): number {
    if (addr >= 0x8000) {
      let a = addr - 0x8000;
      if (this.data_.prg_rom.length === 16384) {
        a %= 16384; // 16KB ROM は $C000 へミラー
      }
      return a < this.data_.prg_rom.length ? this.data_.prg_rom[a]! : 0;
    }
    return read_prg_ram(this.data_, addr);
  }

  write_prg(addr: number, value: number): void {
    // ROM 書き込みは無視。$6000-$7FFF の PRG RAM のみ書ける。
    write_prg_ram(this.data_, addr, value);
  }

  read_chr(addr: number): number {
    return read_chr_rom_or_ram(this.data_, addr);
  }

  write_chr(addr: number, value: number): void {
    // CHR ROM 書き込みは無視。
    write_chr_ram(this.data_, addr, value);
  }
}
