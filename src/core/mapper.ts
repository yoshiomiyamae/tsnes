// Mapper 抽象基底と共有アドレスデコード（移植元 cppnes `mapper.hpp` / `mapper.cpp`）。
//
// C++ の純粋仮想は TS の abstract メソッド、既定実装つき仮想は基底の通常メソッドへ写す。
// make_mapper ファクトリは番号からマッパーを生成する。
import type { StateReader, StateWriter } from "./savestate.ts";

// マッパーに渡す ROM/RAM データ。各マッパーがこれを所有する。
export interface CartridgeData {
  prg_rom: Uint8Array;
  chr_rom: Uint8Array;
  prg_ram: Uint8Array;
  chr_ram: Uint8Array;
}


// 各マッパー共通インターフェース。CartridgeData を 1 個所有する
// （C++ の Mapper + MapperBase を 1 クラスに統合）。
export abstract class Mapper {
  protected data_: CartridgeData;

  constructor(data: CartridgeData) {
    this.data_ = data;
  }

  // ---- 必須 ----
  abstract read_prg(addr: number): number;
  abstract write_prg(addr: number, value: number): void;
  abstract read_chr(addr: number): number;
  abstract write_chr(addr: number, value: number): void;

  cartridge_data(): CartridgeData {
    return this.data_;
  }

  // ---- 既定実装つき（C++ のデフォルト実装つき仮想関数相当）----
  step(): void {}
  is_irq_pending(): boolean {
    return false;
  }
  clear_irq(): void {}
  is_irq_capable(): boolean {
    return false;
  }
  decodes_expansion(): boolean {
    return false;
  }
  // 動的ミラーリング（未指定は null＝カートリッジのヘッダ値を使う）。
  mirroring_mode(): number | null {
    return null;
  }
  notify_a12(_chr_addr: number, _rendering_enabled: boolean): void {}
  tick_cpu(_cycles: number): void {}
  audio_sample(): number {
    return 0;
  }
  // スプライトパターンフェッチ用 CHR 読み（既定は通常の CHR 読み）。
  read_chr_sprite(addr: number): number {
    return this.read_chr(addr);
  }
  set_sprite_size(_is_8x16: boolean): void {}
  notify_scanline(_scanline: number, _rendering_enabled: boolean): void {}

  // バッテリー保存用 PRG RAM の生バイト（.sav 互換のためそのまま書き出す）。
  prg_ram(): Uint8Array {
    return this.data_.prg_ram;
  }

  // バッテリー保存データを PRG RAM へロードする（長さは PRG RAM に切り詰め）。
  load_prg_ram(src: Uint8Array): void {
    const d = this.data_;
    const n = Math.min(src.length, d.prg_ram.length);
    d.prg_ram.set(src.subarray(0, n));
  }

  // マッパー内部レジスタのセーブステート（既定: 状態なし）。
  save_state(_w: StateWriter): void {}
  load_state(_r: StateReader): void {}
}

// ---- 共有アドレスデコード（移植元 common.go）----

// $6000-$7FFF の PRG RAM 読み。範囲外/未割り当ては 0。
export function read_prg_ram(data: CartridgeData, addr: number): number {
  if (addr < 0x6000 || addr >= 0x8000 || data.prg_ram.length === 0) {
    return 0;
  }
  const i = addr - 0x6000;
  return i < data.prg_ram.length ? data.prg_ram[i]! : 0;
}

// $6000-$7FFF の PRG RAM 書き。範囲外/未割り当ては no-op。
export function write_prg_ram(data: CartridgeData, addr: number, value: number): void {
  if (addr < 0x6000 || addr >= 0x8000 || data.prg_ram.length === 0) {
    return;
  }
  const i = addr - 0x6000;
  if (i < data.prg_ram.length) {
    data.prg_ram[i] = value;
  }
}

// CHR ROM があればそれを、無ければ CHR RAM を読む。
export function read_chr_rom_or_ram(data: CartridgeData, addr: number): number {
  if (data.chr_rom.length !== 0) {
    return addr < data.chr_rom.length ? data.chr_rom[addr]! : 0;
  }
  if (data.chr_ram.length !== 0) {
    return addr < data.chr_ram.length ? data.chr_ram[addr]! : 0;
  }
  return 0;
}

// CHR RAM 書き（CHR ROM は read-only なので無視）。
export function write_chr_ram(data: CartridgeData, addr: number, value: number): void {
  if (data.chr_ram.length === 0) {
    return;
  }
  if (addr < data.chr_ram.length) {
    data.chr_ram[addr] = value;
  }
}

// 境界チェック付きバンク読み（C++ の prg_rom_at / chr_rom_at 相当）。
export function prg_rom_at(d: CartridgeData, i: number): number {
  return i < d.prg_rom.length ? d.prg_rom[i]! : 0;
}

export function chr_rom_at(d: CartridgeData, i: number): number {
  return i < d.chr_rom.length ? d.chr_rom[i]! : 0;
}
