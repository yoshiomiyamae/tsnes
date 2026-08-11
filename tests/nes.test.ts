// NES 統合テスト（移植元 cppnes `core/tests/nes_test.cpp`）。
import { describe, expect, test } from "bun:test";
import { Nes } from "../src/core/nes.ts";
import { StateError, StateErrorKind } from "../src/core/savestate.ts";

// 最小の NROM テスト ROM。reset ベクタを $8000 に向け、$8000 から JMP $8000。
function build_loop_rom(): Uint8Array {
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]); // "NES\x1A", PRG 16KB, CHR 8KB
  const prg = 16;
  rom[prg + 0] = 0x4c; // JMP $8000
  rom[prg + 1] = 0x00;
  rom[prg + 2] = 0x80;
  rom[prg + 0x3ffc] = 0x00; // reset vector -> $8000
  rom[prg + 0x3ffd] = 0x80;
  return rom;
}

describe("nes", () => {
  test("power on and run frames", () => {
    const nes = Nes.power_on_from_rom(build_loop_rom());
    expect(nes.cpu.pc).toBe(0x8000);
    for (let i = 0; i < 3; i++) {
      nes.step_frame();
    }
    expect(nes.frame).toBeGreaterThanOrEqual(3);
    expect(nes.cycles).toBeGreaterThan(0);
    expect(nes.cpu.pc).toBe(0x8000); // JMP $8000 無限ループ
  });

  test("savestate round-trips (idempotent)", () => {
    const rom = build_loop_rom();
    const nes = Nes.power_on_from_rom(rom);
    for (let i = 0; i < 5; i++) {
      nes.step_frame();
    }
    const snap = nes.save_state();

    const nes2 = Nes.power_on_from_rom(rom);
    nes2.load_state(snap);
    expect(nes2.save_state()).toEqual(snap); // save→load→save がバイト一致
    expect(nes2.cpu.pc).toBe(nes.cpu.pc);
    expect(nes2.bus.ppu.frame).toBe(nes.bus.ppu.frame);
  });

  test("savestate bad magic", () => {
    const nes = Nes.power_on_from_rom(build_loop_rom());
    try {
      nes.load_state(new Uint8Array(16));
      throw new Error("expected StateError");
    } catch (e) {
      expect(e).toBeInstanceOf(StateError);
      expect((e as StateError).kind).toBe(StateErrorKind.BadMagic);
    }
  });

  test("VBlank flag sets within a frame", () => {
    const nes = Nes.power_on_from_rom(build_loop_rom());
    let saw_vblank = false;
    for (let i = 0; i < 30000; i++) {
      nes.step();
      if (nes.bus.ppu.ppustatus & 0x80) {
        saw_vblank = true;
        break;
      }
    }
    expect(saw_vblank).toBe(true);
  });
});
