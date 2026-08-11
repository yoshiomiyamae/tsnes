// PPU ユニットテスト（移植元 cppnes `core/tests/ppu_test.cpp`）。
import { describe, expect, test } from "bun:test";
import type { Cartridge } from "../src/core/cartridge.ts";
import {
  PPUCTRL_INCREMENT,
  PPUSTATUS_SPRITE_OVERFLOW,
  PPUSTATUS_VBLANK,
  Ppu,
} from "../src/core/ppu.ts";

// private フィールド/メソッドへのテスト用アクセサ（C++ の PpuTestHook 相当。
// TS の private はコンパイル時のみなので、型付きビューで到達する）。
interface PpuInternals {
  v: number;
  x: number;
  w: number;
  current_sprite_count: number;
  current_sprites: { oam_index: number }[];
  evaluate_sprites(sl: number, cart: Cartridge | null): void;
}

function hook(p: Ppu): PpuInternals {
  return p as unknown as PpuInternals;
}

function create_test_ppu(): Ppu {
  const ppu = new Ppu();
  ppu.reset();
  return ppu;
}

const cart: Cartridge | null = null;

describe("ppu", () => {
  test("reset", () => {
    const ppu = create_test_ppu();
    ppu.ppuctrl = 0xff;
    ppu.ppumask = 0xff;
    ppu.ppustatus = 0xff;
    ppu.cycle = 100;
    ppu.scanline = 50;
    ppu.reset();
    expect(ppu.ppuctrl).toBe(0);
    expect(ppu.ppumask).toBe(0);
    expect(ppu.ppustatus).toBe(0);
    expect(ppu.cycle).toBe(0);
    expect(ppu.scanline).toBe(0);
  });

  test("no sprite limit", () => {
    const ppu = create_test_ppu();
    const SCANLINE = 10;
    for (let i = 0; i < 10; i++) {
      ppu.oam[i * 4] = SCANLINE - 1;
      ppu.oam[i * 4 + 1] = 0;
      ppu.oam[i * 4 + 2] = 0;
      ppu.oam[i * 4 + 3] = i * 8;
    }

    // 既定: 8 で打ち止め、9 個目でオーバーフローフラグ。
    ppu.ppustatus = 0;
    ppu.no_sprite_limit = false;
    hook(ppu).evaluate_sprites(SCANLINE, cart);
    expect(hook(ppu).current_sprite_count).toBe(8);
    expect(ppu.ppustatus & PPUSTATUS_SPRITE_OVERFLOW).not.toBe(0);

    // 無制限: 全 10 個。オーバーフローフラグは依然ラッチ。
    ppu.ppustatus = 0;
    ppu.no_sprite_limit = true;
    hook(ppu).evaluate_sprites(SCANLINE, cart);
    expect(hook(ppu).current_sprite_count).toBe(10);
    expect(hook(ppu).current_sprites[8]!.oam_index).toBe(8);
    expect(hook(ppu).current_sprites[9]!.oam_index).toBe(9);
    expect(ppu.ppustatus & PPUSTATUS_SPRITE_OVERFLOW).not.toBe(0);
  });

  test("palette read/write via $2006/$2007", () => {
    const ppu = create_test_ppu();
    ppu.write_register(0x2006, 0x3f, cart);
    ppu.write_register(0x2006, 0x00, cart);
    ppu.write_register(0x2007, 0x0f, cart);

    ppu.write_register(0x2006, 0x3f, cart);
    ppu.write_register(0x2006, 0x00, cart);
    expect(ppu.read_register(0x2007, cart)).toBe(0x0f);
  });

  test("palette mirroring $3F10 -> $3F00", () => {
    const ppu = create_test_ppu();
    ppu.write_register(0x2006, 0x3f, cart);
    ppu.write_register(0x2006, 0x00, cart);
    ppu.write_register(0x2007, 0x20, cart);

    ppu.write_register(0x2006, 0x3f, cart);
    ppu.write_register(0x2006, 0x10, cart);
    expect(ppu.read_register(0x2007, cart)).toBe(0x20);
  });

  test("PPUSTATUS VBlank read clears flag", () => {
    const ppu = create_test_ppu();
    ppu.ppustatus = ppu.ppustatus | PPUSTATUS_VBLANK;
    expect(ppu.read_register(0x2002, cart) & PPUSTATUS_VBLANK).not.toBe(0);
    expect(ppu.read_register(0x2002, cart) & PPUSTATUS_VBLANK).toBe(0);
  });

  test("OAM write auto-increments OAMADDR", () => {
    const ppu = create_test_ppu();
    ppu.write_register(0x2003, 0x10, cart);
    ppu.write_register(0x2004, 0x50, cart);
    ppu.write_register(0x2004, 0x01, cart);
    ppu.write_register(0x2004, 0x02, cart);
    ppu.write_register(0x2004, 0x60, cart);
    expect(ppu.oam[0x10]).toBe(0x50);
    expect(ppu.oam[0x11]).toBe(0x01);
    expect(ppu.oam[0x12]).toBe(0x02);
    expect(ppu.oam[0x13]).toBe(0x60);
    expect(ppu.oamaddr).toBe(0x14);
  });

  test("frame timing reaches VBlank then completes", () => {
    const ppu = create_test_ppu();
    while (ppu.scanline < 241 || (ppu.scanline === 241 && ppu.cycle === 0)) {
      ppu.step(cart);
    }
    expect(ppu.ppustatus & PPUSTATUS_VBLANK).not.toBe(0);

    while (!ppu.frame_complete) {
      ppu.step(cart);
    }
    expect(ppu.frame_complete).toBe(true);
    expect(ppu.ppustatus & PPUSTATUS_VBLANK).toBe(0);
  });

  test("VRAM address increment (1 then 32)", () => {
    const ppu = create_test_ppu();
    ppu.write_register(0x2006, 0x20, cart);
    ppu.write_register(0x2006, 0x00, cart);
    ppu.write_register(0x2007, 0xaa, cart);
    expect(hook(ppu).v).toBe(0x2001);

    ppu.ppuctrl = ppu.ppuctrl | PPUCTRL_INCREMENT;
    ppu.write_register(0x2006, 0x20, cart);
    ppu.write_register(0x2006, 0x00, cart);
    ppu.write_register(0x2007, 0xbb, cart);
    expect(hook(ppu).v).toBe(0x2020);
  });

  test("scroll register write toggles w", () => {
    const ppu = create_test_ppu();
    ppu.write_register(0x2005, 0x08, cart);
    expect(hook(ppu).x).toBe(0); // fine X は scanline 開始まで x_temp のまま
    expect(hook(ppu).w).toBe(1);
    ppu.write_register(0x2005, 0x10, cart);
    expect(hook(ppu).w).toBe(0);
  });
});
