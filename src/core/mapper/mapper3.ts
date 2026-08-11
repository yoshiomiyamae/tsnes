// Mapper 3 (CNROM) — PRG 固定、8KB CHR バンク切替（移植元 cppnes `mapper/mapper3.hpp`）。
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

// CNROM。CHR バンクを切り替える。16KB PRG は $8000/$C000 にミラー。
export class Mapper3 extends Mapper {
  private chr_bank_ = 0;
  private readonly chr_bank_count_: number;
  private readonly prg_mask_: number;
  private bus_conflict_mode_ = 1; // 既定: コンフリクトなし

  constructor(data: CartridgeData) {
    super(data);
    this.chr_bank_count_ = data.chr_rom.length === 0 ? 0 : Math.floor(data.chr_rom.length / 8192) & 0xff;
    this.prg_mask_ = data.prg_rom.length === 16384 ? 0x3fff : 0x7fff;
  }

  // サブマッパーに応じたバスコンフリクト挙動（0=不明,1=なし,2=AND）。
  set_bus_conflict_mode(mode: number): void {
    if (mode <= 2) this.bus_conflict_mode_ = mode;
  }

  read_prg(addr: number): number {
    if (addr >= 0x8000) {
      return prg_rom_at(this.data_, (addr - 0x8000) & this.prg_mask_);
    }
    if (addr >= 0x6000) {
      return read_prg_ram(this.data_, addr);
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0x8000) {
      const effective = this.bus_conflict_mode_ === 2 ? value & this.read_prg(addr) : value;
      this.chr_bank_ = effective & 0x03;
      return;
    }
    write_prg_ram(this.data_, addr, value);
  }

  read_chr(addr: number): number {
    if (this.data_.chr_rom.length !== 0) {
      const bank = this.chr_bank_count_ > 0 ? this.chr_bank_ % this.chr_bank_count_ : 0;
      return chr_rom_at(this.data_, bank * 8192 + addr);
    }
    return read_chr_rom_or_ram(this.data_, addr);
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  save_state(w: StateWriter): void {
    w.u8(this.chr_bank_);
  }

  load_state(r: StateReader): void {
    this.chr_bank_ = r.u8();
  }
}
