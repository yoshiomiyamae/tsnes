// Cartridge(iNES) + Mapper0 ユニットテスト（移植元 cppnes `core/tests/cartridge_test.cpp`）。
import { describe, expect, test } from "bun:test";
import { Cartridge } from "../src/core/cartridge.ts";
import type { CartridgeData } from "../src/core/mapper.ts";
import { Mapper0 } from "../src/core/mapper/mapper0.ts";

// 指定マッパーの iNES イメージを合成する（移植元 build_ines 相当）。
function build_ines(mapper: number, prg16k: number, chr8k: number): Uint8Array {
  const header = [
    0x4e, 0x45, 0x53, 0x1a, // "NES\x1A"
    prg16k,
    chr8k,
    (mapper & 0x0f) << 4, // flags6: 下位ニブル
    mapper & 0xf0, // flags7: 上位ニブル
    0, 0, 0, 0, 0, 0, 0, 0, // flags8-10 + padding
  ];
  const buf = new Uint8Array(header.length + prg16k * 16384 + chr8k * 8192);
  buf.set(header);
  return buf;
}

// パターン入り PRG/CHR を持つ CartridgeData を作る。
function patterned(
  prg_len: number,
  chr_rom_len: number,
  chr_ram_len: number,
  prg_ram_len: number,
): CartridgeData {
  const prg_rom = new Uint8Array(prg_len);
  for (let i = 0; i < prg_len; i++) prg_rom[i] = i & 0xff;
  const chr_rom = new Uint8Array(chr_rom_len);
  for (let i = 0; i < chr_rom_len; i++) chr_rom[i] = i & 0xff;
  return {
    prg_rom,
    chr_rom,
    prg_ram: new Uint8Array(prg_ram_len),
    chr_ram: new Uint8Array(chr_ram_len),
  };
}

describe("cartridge", () => {
  test("load NROM", () => {
    const cart = Cartridge.from_bytes(build_ines(0, 2, 1));
    expect(cart.has_irq()).toBe(false);
    expect(cart.has_expansion()).toBe(false);
    expect(cart.get_mirroring()).toBe(0); // 水平
  });

  test("invalid magic is rejected", () => {
    const rom = build_ines(0, 1, 1);
    rom[0] = 0x58; // 'X'
    expect(() => Cartridge.from_bytes(rom)).toThrow();
  });

  test("vertical mirroring flag", () => {
    const rom = build_ines(0, 1, 1);
    rom[6] = rom[6]! | 0x01; // 垂直ミラー
    const cart = Cartridge.from_bytes(rom);
    expect(cart.get_mirroring()).toBe(1);
  });

  test("unsupported mapper errors", () => {
    // Mapper 9 は未対応。
    expect(() => Cartridge.from_bytes(build_ines(9, 1, 1))).toThrow();
  });
});

describe("mapper0", () => {
  test("NROM-128 mirrors 16KB PRG to $C000", () => {
    const m = new Mapper0(patterned(16 * 1024, 8 * 1024, 0, 0));
    expect(m.read_prg(0x8000)).toBe(m.read_prg(0xc000));
    expect(m.read_prg(0x8001)).toBe(0x01);
    expect(m.read_chr(0x0000)).toBe(0x00);
    expect(m.read_chr(0x0001)).toBe(0x01);
  });

  test("NROM-256 32KB PRG has no mirroring", () => {
    const pat = (i: number) => i & 0xff;
    const m = new Mapper0(patterned(32 * 1024, 8 * 1024, 0, 0));
    expect(m.read_prg(0x8000)).toBe(pat(0x0000));
    expect(m.read_prg(0xc000)).toBe(pat(0x4000));
    expect(m.read_prg(0x8000)).toBe(0x00);
    expect(m.read_prg(0xffff)).toBe(0xff);
  });

  test("CHR RAM support", () => {
    const m = new Mapper0(patterned(16 * 1024, 0, 8 * 1024, 0));
    m.write_chr(0x1000, 0xab);
    expect(m.read_chr(0x1000)).toBe(0xab);
  });

  test("PRG RAM support, ROM is read-only", () => {
    const m = new Mapper0(patterned(16 * 1024, 8 * 1024, 0, 2 * 1024));
    m.write_prg(0x6000, 0xcd);
    expect(m.read_prg(0x6000)).toBe(0xcd);
    const original = m.read_prg(0x8000);
    m.write_prg(0x8000, 0xff);
    expect(m.read_prg(0x8000)).toBe(original);
  });

  test("IRQ unsupported", () => {
    const m = new Mapper0(patterned(16 * 1024, 8 * 1024, 0, 0));
    expect(m.is_irq_pending()).toBe(false);
    expect(m.is_irq_capable()).toBe(false);
    m.clear_irq();
    m.step();
  });
});
