// Mapper 10 (MMC4/FxROM) — CHR latch（移植元 cppnes `mapper/mapper10.hpp`）。
// PPU が タイル $FD/$FE をフェッチすると CHR バンクが自動で切り替わる。
import {
  type CartridgeData,
  Mapper,
  prg_rom_at,
  read_prg_ram,
  write_prg_ram,
} from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

export class Mapper10 extends Mapper {
  private prg_bank_ = 0;
  private readonly prg_bank_count_: number;
  private chr_bank0_fd_ = 0;
  private chr_bank0_fe_ = 0;
  private chr_bank1_fd_ = 0;
  private chr_bank1_fe_ = 0;
  private readonly chr_bank_count_: number;
  private latch0_ = 0xfe;
  private latch1_ = 0xfe;
  private mirroring_ = 0;

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ = Math.floor(data.prg_rom.length / 16384) & 0xff;
    this.chr_bank_count_ =
      data.chr_rom.length === 0 ? 0 : Math.floor(data.chr_rom.length / 4096) & 0xff;
  }

  read_prg(addr: number): number {
    if (addr >= 0xc000) {
      const offset = (this.prg_bank_count_ - 1) * 16384 + (addr - 0xc000);
      return prg_rom_at(this.data_, offset);
    }
    if (addr >= 0x8000) {
      const bank = this.prg_bank_count_ > 0 ? this.prg_bank_ % this.prg_bank_count_ : 0;
      return prg_rom_at(this.data_, bank * 16384 + (addr - 0x8000));
    }
    if (addr >= 0x6000) {
      return read_prg_ram(this.data_, addr);
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0xf000) {
      this.mirroring_ = value & 1;
    } else if (addr >= 0xe000) {
      this.chr_bank1_fe_ = value & 0x1f;
    } else if (addr >= 0xd000) {
      this.chr_bank1_fd_ = value & 0x1f;
    } else if (addr >= 0xc000) {
      this.chr_bank0_fe_ = value & 0x1f;
    } else if (addr >= 0xb000) {
      this.chr_bank0_fd_ = value & 0x1f;
    } else if (addr >= 0xa000) {
      this.prg_bank_ = value & 0x0f;
    } else if (addr >= 0x6000 && addr < 0x8000) {
      write_prg_ram(this.data_, addr, value);
    }
    // $8000-$9FFF は無視
  }

  read_chr(addr: number): number {
    // 現在の latch でフェッチ → その後 latch を更新（次回読みから反映）。
    const value = this.chr_fetch(addr);
    if (addr >= 0x0fd8 && addr <= 0x0fdf) {
      this.latch0_ = 0xfd;
    } else if (addr >= 0x0fe8 && addr <= 0x0fef) {
      this.latch0_ = 0xfe;
    } else if (addr >= 0x1fd8 && addr <= 0x1fdf) {
      this.latch1_ = 0xfd;
    } else if (addr >= 0x1fe8 && addr <= 0x1fef) {
      this.latch1_ = 0xfe;
    }
    return value;
  }

  write_chr(addr: number, value: number): void {
    if (this.data_.chr_ram.length === 0 || addr >= 0x2000) return;
    if (addr < this.data_.chr_ram.length) this.data_.chr_ram[addr] = value;
  }

  mirroring_mode(): number | null {
    return this.mirroring_ === 0 ? 1 : 0;
  }

  save_state(w: StateWriter): void {
    w.u8(this.prg_bank_);
    w.u8(this.chr_bank0_fd_);
    w.u8(this.chr_bank0_fe_);
    w.u8(this.chr_bank1_fd_);
    w.u8(this.chr_bank1_fe_);
    w.u8(this.latch0_);
    w.u8(this.latch1_);
    w.u8(this.mirroring_);
  }

  load_state(r: StateReader): void {
    this.prg_bank_ = r.u8();
    this.chr_bank0_fd_ = r.u8();
    this.chr_bank0_fe_ = r.u8();
    this.chr_bank1_fd_ = r.u8();
    this.chr_bank1_fe_ = r.u8();
    this.latch0_ = r.u8();
    this.latch1_ = r.u8();
    this.mirroring_ = r.u8();
  }

  // テスト用（ユニットテストが直接呼ぶ）。
  chr_fetch(addr: number): number {
    let bank =
      addr < 0x1000
        ? this.latch0_ === 0xfd
          ? this.chr_bank0_fd_
          : this.chr_bank0_fe_
        : this.latch1_ === 0xfd
          ? this.chr_bank1_fd_
          : this.chr_bank1_fe_;
    if (this.chr_bank_count_ > 0) bank = bank % this.chr_bank_count_;
    const offset = bank * 4096 + (addr & 0x0fff);
    if (offset < this.data_.chr_rom.length) return this.data_.chr_rom[offset]!;
    return offset < this.data_.chr_ram.length ? this.data_.chr_ram[offset]! : 0;
  }
}
