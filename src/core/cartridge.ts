// iNES カートリッジローダ（移植元 cppnes `cartridge.hpp` / `cartridge.cpp`）。
//
// マッパーが CartridgeData を所有し、Cartridge は Mapper を持って委譲する。
import type { CartridgeData, Mapper } from "./mapper.ts";
import { make_mapper } from "./mapper/factory.ts";
import type { StateReader, StateWriter } from "./savestate.ts";

// ネームテーブルのミラーリング方式。
export enum MirroringMode {
  Horizontal,
  Vertical,
  FourScreen,
  SingleScreenA,
  SingleScreenB,
}

export class Cartridge {
  readonly mapper: Mapper;
  mirroring: MirroringMode;

  private readonly has_expansion_: boolean;
  private readonly has_irq_: boolean;
  private readonly has_battery_: boolean;

  private constructor(
    mapper: Mapper,
    mirroring: MirroringMode,
    expansion: boolean,
    irq: boolean,
    battery: boolean,
  ) {
    this.mapper = mapper;
    this.mirroring = mirroring;
    this.has_expansion_ = expansion;
    this.has_irq_ = irq;
    this.has_battery_ = battery;
  }

  // iNES バイト列からカートリッジをロードする（失敗時は Error を投げる）。
  static from_bytes(rom: Uint8Array): Cartridge {
    if (rom.length < 16) {
      throw new Error("ROM too small for iNES header");
    }
    if (!(rom[0] === 0x4e && rom[1] === 0x45 && rom[2] === 0x53 && rom[3] === 0x1a)) {
      throw new Error("invalid iNES magic number");
    }

    const prg_units = rom[4]!;
    const chr_units = rom[5]!;
    const flags6 = rom[6]!;
    const flags7 = rom[7]!;
    const mapper_number = ((flags6 >> 4) | (flags7 & 0xf0)) & 0xff;

    let offset = 16;
    if (flags6 & 0x04) {
      offset += 512; // トレーナーをスキップ
    }

    const prg_size = prg_units * 16384;
    if (rom.length < offset + prg_size) {
      throw new Error("failed to read PRG ROM");
    }
    const prg_rom = rom.slice(offset, offset + prg_size);
    offset += prg_size;

    const chr_size = chr_units * 8192;
    let chr_rom = new Uint8Array(0);
    let chr_ram = new Uint8Array(0);
    if (chr_size > 0) {
      if (rom.length < offset + chr_size) {
        throw new Error("failed to read CHR ROM");
      }
      chr_rom = rom.slice(offset, offset + chr_size);
    } else {
      // CHR RAM。MMC3 ゲームは 32KB を期待することが多い。
      chr_ram = new Uint8Array(mapper_number === 4 ? 32768 : 8192);
    }

    // PRG RAM: バッテリー付きは 32KB、それ以外も blargg のステータス protocol が
    // $6000+ を使うため常に確保する。
    const prg_ram = new Uint8Array(flags6 & 0x02 ? 32768 : 8192);

    let mirroring = MirroringMode.Horizontal;
    if (flags6 & 0x08) {
      mirroring = MirroringMode.FourScreen;
    } else if (flags6 & 0x01) {
      mirroring = MirroringMode.Vertical;
    }

    const data: CartridgeData = { prg_rom, chr_rom, prg_ram, chr_ram };
    const mapper = make_mapper(mapper_number, data);
    const has_expansion = mapper.decodes_expansion();
    const has_irq = mapper.is_irq_capable();
    const has_battery = (flags6 & 0x02) !== 0;

    return new Cartridge(mapper, mirroring, has_expansion, has_irq, has_battery);
  }

  // ---- 属性 ----
  has_irq(): boolean {
    return this.has_irq_;
  }
  has_expansion(): boolean {
    return this.has_expansion_;
  }
  has_battery(): boolean {
    return this.has_battery_;
  }

  // ---- バッテリー RAM（.sav, gones 互換）----
  save_ram(): Uint8Array {
    return this.mapper.prg_ram();
  }
  load_ram(data: Uint8Array): void {
    this.mapper.load_prg_ram(data);
  }

  // ---- マッパー委譲 ----
  read_prg(addr: number): number {
    return this.mapper.read_prg(addr);
  }
  write_prg(addr: number, value: number): void {
    this.mapper.write_prg(addr, value);
  }
  read_chr(addr: number): number {
    return this.mapper.read_chr(addr);
  }
  read_chr_sprite(addr: number): number {
    return this.mapper.read_chr_sprite(addr);
  }
  write_chr(addr: number, value: number): void {
    this.mapper.write_chr(addr, value);
  }
  set_sprite_size(is_8x16: boolean): void {
    this.mapper.set_sprite_size(is_8x16);
  }
  notify_scanline(scanline: number, rendering_enabled: boolean): void {
    this.mapper.notify_scanline(scanline, rendering_enabled);
  }
  audio_sample(): number {
    return this.mapper.audio_sample();
  }
  step(): void {
    this.mapper.step();
  }
  tick_cpu(cycles: number): void {
    this.mapper.tick_cpu(cycles);
  }
  is_irq_pending(): boolean {
    return this.mapper.is_irq_pending();
  }
  clear_irq(): void {
    this.mapper.clear_irq();
  }
  notify_a12(chr_addr: number, rendering_enabled: boolean): void {
    this.mapper.notify_a12(chr_addr, rendering_enabled);
  }

  // 現在のミラーリング方式を数値で返す（0=水平, 1=垂直, ...）。マッパーが動的に
  // 上書きする場合はそちらを優先する。
  get_mirroring(): number {
    const m = this.mapper.mirroring_mode();
    if (m !== null) {
      return m;
    }
    switch (this.mirroring) {
      case MirroringMode.Horizontal:
        return 0;
      case MirroringMode.Vertical:
        return 1;
      default:
        return 0;
    }
  }

  // ---- セーブステート ----
  save_state(w: StateWriter): void {
    // 書き換え可能な PRG/CHR RAM + マッパーレジスタ。ROM は不変なので保存しない。
    const d = this.mapper.cartridge_data();
    w.vec(d.prg_ram);
    w.vec(d.chr_ram);
    this.mapper.save_state(w);
  }

  load_state(r: StateReader): void {
    const prg = r.vec();
    const chr = r.vec();
    const d = this.mapper.cartridge_data();
    d.prg_ram.set(prg.subarray(0, Math.min(prg.length, d.prg_ram.length)));
    d.chr_ram.set(chr.subarray(0, Math.min(chr.length, d.chr_ram.length)));
    this.mapper.load_state(r);
  }
}
