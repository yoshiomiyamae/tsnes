// マッパー 1/2/3/4/5/10/69/70 ユニットテスト（移植元 cppnes `core/tests/mappers_test.cpp`）。
import { describe, expect, test } from "bun:test";
import type { CartridgeData } from "../src/core/mapper.ts";
import { Mapper1 } from "../src/core/mapper/mapper1.ts";
import { Mapper10 } from "../src/core/mapper/mapper10.ts";
import { Mapper2 } from "../src/core/mapper/mapper2.ts";
import { Mapper3 } from "../src/core/mapper/mapper3.ts";
import { Mapper4 } from "../src/core/mapper/mapper4.ts";
import { Mapper5 } from "../src/core/mapper/mapper5.ts";
import { Mapper69 } from "../src/core/mapper/mapper69.ts";
import { Mapper70 } from "../src/core/mapper/mapper70.ts";

function pattern(len: number, unit: number, base: number): Uint8Array {
  const v = new Uint8Array(len);
  for (let i = 0; i < len; i++) v[i] = (Math.floor(i / unit) + base) & 0xff;
  return v;
}

function data(
  prg: Uint8Array,
  chr_rom: Uint8Array,
  chr_ram: Uint8Array,
  prg_ram: number,
): CartridgeData {
  return { prg_rom: prg, chr_rom, prg_ram: new Uint8Array(prg_ram), chr_ram };
}

const EMPTY = new Uint8Array(0);

describe("mapper2", () => {
  test("PRG bank switching, last bank fixed", () => {
    const m = new Mapper2(data(pattern(8 * 16384, 16384, 1), EMPTY, new Uint8Array(8192), 8192));
    expect(m.read_prg(0x8000)).toBe(0x01);
    expect(m.read_prg(0xc000)).toBe(0x08);
    m.write_prg(0x8000, 0x02);
    expect(m.read_prg(0x8000)).toBe(0x03);
    expect(m.read_prg(0xc000)).toBe(0x08);
    const m2 = new Mapper2(
      data(pattern(4 * 16384, 16384, 0x10), EMPTY, new Uint8Array(8192), 8192),
    );
    m2.write_prg(0x8000, 0x07); // wraps to bank 3 (7 % 4)
    expect(m2.read_prg(0x8000)).toBe(0x13);
  });
});

describe("mapper3", () => {
  test("CHR bank switching + 16KB PRG mirror", () => {
    const m = new Mapper3(
      data(new Uint8Array(32 * 1024), pattern(4 * 8192, 8192, 1), EMPTY, 8192),
    );
    expect(m.read_chr(0x0000)).toBe(0x01);
    m.write_prg(0x8000, 0x02);
    expect(m.read_chr(0x0000)).toBe(0x03);
    expect(m.read_chr(0x1000)).toBe(0x03);

    const prg = new Uint8Array(16384);
    prg[0] = 0xab;
    prg[0x3fff] = 0xcd;
    const m2 = new Mapper3(data(prg, pattern(8192, 8192, 1), EMPTY, 8192));
    expect(m2.read_prg(0x8000)).toBe(0xab);
    expect(m2.read_prg(0xc000)).toBe(0xab); // 16KB mirror
    expect(m2.read_prg(0xffff)).toBe(0xcd);
  });
});

describe("mapper70", () => {
  test("PRG+CHR switch together, bit7 ignored", () => {
    const make = () =>
      new Mapper70(data(pattern(8 * 16384, 16384, 1), pattern(8 * 8192, 8192, 0x10), EMPTY, 8192));
    const m = make();
    expect(m.read_prg(0x8000)).toBe(0x01);
    expect(m.read_prg(0xc000)).toBe(0x08);
    expect(m.read_chr(0x0000)).toBe(0x10);
    m.write_prg(0x8000, 0x53); // prg=5, chr=3
    expect(m.read_prg(0x8000)).toBe(0x06);
    expect(m.read_chr(0x0000)).toBe(0x13);
    const m2 = make();
    m2.write_prg(0x8000, 0x80 | 0x12); // bit7 set, prg1, chr2
    expect(m2.read_prg(0x8000)).toBe(0x02);
    expect(m2.read_chr(0x0000)).toBe(0x12);
  });
});

function write_serial(m: Mapper1, addr: number, value: number): void {
  for (let i = 0; i < 5; i++) m.write_prg(addr, (value >> i) & 1);
}

describe("mapper1", () => {
  test("reset + PRG bank switch in mode 3", () => {
    const m = new Mapper1(
      data(pattern(8 * 16384, 16384, 1), new Uint8Array(8192), EMPTY, 8192),
    );
    m.write_prg(0x8000, 0x80); // reset → mode 3
    expect(m.read_prg(0xc000)).toBe(8); // last bank fixed
    write_serial(m, 0xe000, 0x02); // PRG bank 2
    expect(m.read_prg(0x8000)).toBe(3);
    expect(m.read_prg(0xc000)).toBe(8);
  });

  test("mirroring translation", () => {
    const m = new Mapper1(
      data(pattern(2 * 16384, 16384, 1), new Uint8Array(8192), EMPTY, 8192),
    );
    write_serial(m, 0x8000, 0b00011); // horizontal
    expect(m.mirroring_mode()).toBe(0);
    write_serial(m, 0x8000, 0b00010); // vertical
    expect(m.mirroring_mode()).toBe(1);
  });
});

describe("mapper10", () => {
  test("PRG banking + CHR latch + mirroring", () => {
    const make = () =>
      new Mapper10(data(pattern(4 * 16384, 16384, 1), pattern(8 * 4096, 4096, 0x20), EMPTY, 8192));
    const m = make();
    m.write_prg(0xa000, 0x02);
    expect(m.read_prg(0x8000)).toBe(0x03);
    expect(m.read_prg(0xc000)).toBe(0x04); // last bank

    const m2 = make();
    m2.write_prg(0xc000, 0x01); // chr_bank0_fe = 1
    m2.write_prg(0xb000, 0x03); // chr_bank0_fd = 3
    expect(m2.chr_fetch(0x0000)).toBe(0x21);
    m2.read_chr(0x0fd8); // → latch0 = FD
    expect(m2.chr_fetch(0x0000)).toBe(0x23);
    m2.read_chr(0x0fe8); // → latch0 = FE
    expect(m2.chr_fetch(0x0000)).toBe(0x21);

    const m3 = make();
    m3.write_prg(0xf000, 0x00);
    expect(m3.mirroring_mode()).toBe(1);
    m3.write_prg(0xf000, 0x01);
    expect(m3.mirroring_mode()).toBe(0);
  });
});

function make_mmc3(prg_len: number, chr_len: number, prg_ram = 0): Mapper4 {
  return new Mapper4(
    data(
      pattern(prg_len, 8192, 1),
      chr_len ? pattern(chr_len, 1024, 1) : EMPTY,
      chr_len ? EMPTY : new Uint8Array(8192),
      prg_ram,
    ),
  );
}

describe("mapper4", () => {
  test("PRG/CHR banking modes", () => {
    const m = make_mmc3(256 * 1024, 0);
    expect(m.read_prg(0xe000)).toBe((256 * 1024) / 8192); // last bank

    m.write_prg(0x8000, 0x06); // R6
    m.write_prg(0x8001, 0x0a); // R6 = bank 10
    expect(m.read_prg(0x8000)).toBe(0x0b);
    m.write_prg(0x8000, 0x46); // PRG mode 1
    expect(m.read_prg(0xc000)).toBe(0x0b);

    const mc = make_mmc3(32 * 1024, 128 * 1024);
    mc.write_prg(0x8000, 0x00); // R0
    mc.write_prg(0x8001, 0x14); // R0 = bank 20
    expect(mc.read_chr(0x0000)).toBe(0x15);
    mc.write_prg(0x8000, 0x80); // CHR mode 1
    mc.write_prg(0x8001, 0x00); // R0 = bank 0
    expect(mc.read_chr(0x1000)).toBe(0x01);
  });

  test("mirroring + IRQ registers + A12 clocking", () => {
    const m = make_mmc3(32 * 1024, 0);
    m.write_prg(0xa000, 0x00);
    expect(m.get_mirroring_mode()).toBe(1);
    m.write_prg(0xa000, 0x01);
    expect(m.get_mirroring_mode()).toBe(0);

    m.write_prg(0xc000, 0x08); // latch
    m.write_prg(0xc001, 0x00); // reload
    m.write_prg(0xe001, 0x00); // enable
    const s = m.irq_state();
    expect(s.reload).toBe(0x08);
    expect(s.enabled).toBe(true);
    expect(s.pending).toBe(false);
    m.write_prg(0xe000, 0x00); // disable + ack
    expect(m.irq_state().enabled).toBe(false);

    // A12 立ち上がり 3 回でカウンタ 2→1→0(発火)。低→高の遷移を作るため間に 0x0000。
    const mi = make_mmc3(32 * 1024, 0);
    mi.write_prg(0xc000, 0x02);
    mi.write_prg(0xc001, 0x00);
    mi.write_prg(0xe001, 0x00);
    mi.notify_a12(0x1000, false); // reload, counter=2
    expect(mi.is_irq_pending()).toBe(false);
    mi.notify_a12(0x0000, false);
    mi.notify_a12(0x1000, false); // 2→1
    expect(mi.is_irq_pending()).toBe(false);
    mi.notify_a12(0x0000, false);
    mi.notify_a12(0x1000, false); // 1→0 発火
    expect(mi.is_irq_pending()).toBe(true);
    mi.clear_irq();
    expect(mi.is_irq_pending()).toBe(false);
  });
});

function make_mmc5(): Mapper5 {
  return new Mapper5(data(pattern(16 * 8192, 8192, 1), pattern(16 * 1024, 1024, 0x40), EMPTY, 8192));
}

describe("mapper5", () => {
  test("power-on, multiplier, ExRAM, banking, scanline IRQ", () => {
    const m = make_mmc5();
    expect(m.read_prg(0xe000)).toBe(16); // last bank at $E000

    m.write_prg(0x5205, 7);
    m.write_prg(0x5206, 6);
    expect(m.read_prg(0x5205)).toBe(42);
    expect(m.read_prg(0x5206)).toBe(0);
    m.write_prg(0x5205, 0xff);
    m.write_prg(0x5206, 0xff);
    expect(m.read_prg(0x5205)).toBe(0x01);
    expect(m.read_prg(0x5206)).toBe(0xfe);

    m.write_prg(0x5104, 0x02); // ExRAM mode 2 (RW)
    m.write_prg(0x5c00, 0xab);
    expect(m.read_prg(0x5c00)).toBe(0xab);
    m.write_prg(0x5104, 0x03); // read-only
    m.write_prg(0x5c00, 0x00);
    expect(m.read_prg(0x5c00)).toBe(0xab);

    m.write_prg(0x5100, 0x03); // PRG mode 3
    m.write_prg(0x5114, 0x80 | 2); // $8000 ROM bank 2
    expect(m.read_prg(0x8000)).toBe(3);
    m.write_prg(0x5101, 0x03); // CHR mode 3
    m.write_prg(0x5120, 5); // chrA[0] = bank 5
    expect(m.read_chr(0x0000)).toBe(0x45);

    const mi = make_mmc5();
    mi.write_prg(0x5203, 3); // target scanline 3
    mi.write_prg(0x5204, 0x80); // enable
    mi.notify_scanline(0, true);
    mi.notify_scanline(1, true);
    mi.notify_scanline(2, true);
    expect(mi.is_irq_pending()).toBe(false);
    mi.notify_scanline(3, true);
    expect(mi.is_irq_pending()).toBe(true);
    mi.read_prg(0x5204); // 読みで pending クリア
    expect(mi.is_irq_pending()).toBe(false);
  });
});

function make_fme7(): Mapper69 {
  return new Mapper69(
    data(pattern(8 * 8192, 8192, 1), pattern(16 * 1024, 1024, 0x40), EMPTY, 8192),
  );
}

function fme7_reg(m: Mapper69, reg: number, value: number): void {
  m.write_prg(0x8000, reg);
  m.write_prg(0xa000, value);
}

describe("mapper69", () => {
  test("banking, mirroring, IRQ underflow", () => {
    const m = make_fme7();
    expect(m.read_prg(0xe000)).toBe(8); // last bank fixed
    fme7_reg(m, 9, 2);
    expect(m.read_prg(0x8000)).toBe(3);
    fme7_reg(m, 0, 5);
    expect(m.read_chr(0x0000)).toBe(0x45);
    fme7_reg(m, 1, 3);
    expect(m.read_chr(0x0400)).toBe(0x43);

    fme7_reg(m, 12, 0);
    expect(m.mirroring_mode()).toBe(1);
    fme7_reg(m, 12, 1);
    expect(m.mirroring_mode()).toBe(0);

    const mi = make_fme7();
    expect(mi.is_irq_capable()).toBe(true);
    fme7_reg(mi, 14, 0x02); // counter low = 2
    fme7_reg(mi, 15, 0x00); // counter high = 0 → 2
    fme7_reg(mi, 13, 0x81); // enable counter + IRQ
    mi.tick_cpu(2);
    expect(mi.is_irq_pending()).toBe(false);
    mi.tick_cpu(1); // underflow → IRQ
    expect(mi.is_irq_pending()).toBe(true);
    fme7_reg(mi, 13, 0x00); // ack
    expect(mi.is_irq_pending()).toBe(false);
  });
});
