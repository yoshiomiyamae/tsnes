// 市販 ROM ベースの統合テスト（移植元 cppnes `smoke.cpp` / `savestate_rom.cpp` /
// `compat.cpp` / `render_regression.cpp`）。
//
// 著作権 ROM はコミットしないため、TSNES_GAME_ROMS（既定 R:/）に ROM が
// 無ければ skip する。黄金ハッシュは rsnes → cppnes と受け継いだ値をそのまま使う
// （一致＝フレームバッファが rsnes/cppnes とバイト同一）。
import { describe, expect, test } from "bun:test";
import { load_str } from "../src/core/cheat.ts";
import { Nes } from "../src/core/nes.ts";
import { game_roms_dir, read_file } from "./common.ts";

const dir = game_roms_dir();

function load(name: string): Uint8Array | null {
  return dir === null ? null : read_file(dir, name);
}

// フレームバッファの FNV-1a 64bit ハッシュ（rsnes/cppnes と同一アルゴリズム）。
function fb_hash(nes: Nes): bigint {
  let h = 0xcbf29ce484222325n;
  const MASK = 0xffffffffffffffffn;
  const PRIME = 0x100000001b3n;
  for (const px of nes.framebuffer()) {
    for (let i = 0; i < 4; i++) {
      const b = BigInt((px >>> (i * 8)) & 0xff); // LE
      h = (h ^ b) & MASK;
      h = (h * PRIME) & MASK;
    }
  }
  return h;
}

// (ROM ファイル名, フレーム数, 期待ハッシュ) — rsnes/cppnes の黄金値。
const RENDER_CASES: Array<[string, number, bigint]> = [
  ["Tetris (J).nes", 200, 0x935f010e5d4ee514n],
  ["Super Mario Bros. 3 (J).nes", 200, 0x6977d3ccae2fe92dn],
  ["Final Fantasy II (J).nes", 220, 0xca2acc95df7a0755n],
  ["Spartan X (J) [!].nes", 200, 0x5460f66e6c0f4e75n],
  ["TwinBee (J).nes", 200, 0x3e0241b3a0e206fdn],
  ["Fire Emblem Gaiden (J).nes", 220, 0xbebd12fec0c0edb5n],
  ["Kamen Rider Club (J).nes", 200, 0xddb82877d2ff9b26n],
  ["Hebereke (J).nes", 200, 0xe580495151c02ee0n],
  ["Gimmick! (J).nes", 200, 0xa8c20e0adae62325n],
  ["Metal Slader Glory (J).nes", 200, 0x3daa90f41fc4f449n],
];

const SMOKE_ROMS = [
  "Super Mario Bros. 3 (J).nes", // MMC3
  "Final Fantasy II (J).nes", // MMC1
  "Final Fantasy III (J).nes", // MMC1
  "Tetris (J).nes", // CNROM
  "Spartan X (J) [!].nes", // NROM
  "TwinBee (J).nes", // CNROM
  "Fire Emblem Gaiden (J).nes", // MMC4 (mapper 10)
  "Kamen Rider Club (J).nes", // Bandai (mapper 70)
  "Hebereke (J).nes", // FME-7 (mapper 69)
  "Gimmick! (J).nes", // FME-7 + expansion audio
  "Metal Slader Glory (J).nes", // MMC5 (mapper 5)
];

describe("rom integration", () => {
  test.skipIf(dir === null)("smoke: real games boot without crashing", () => {
    let tested = 0;
    for (const name of SMOKE_ROMS) {
      const rom = load(name);
      if (rom === null) continue;
      const nes = Nes.power_on_from_rom(rom);
      for (let i = 0; i < 120; i++) nes.step_frame();
      expect(nes.frame).toBeGreaterThanOrEqual(120);
      tested++;
    }
    if (tested === 0) console.warn("no commercial ROMs present — smoke skipped");
  }, 300_000);

  test.skipIf(dir === null)("render: golden framebuffer hashes match rsnes/cppnes", () => {
    const mismatches: string[] = [];
    let tested = 0;
    for (const [name, frames, expected] of RENDER_CASES) {
      const rom = load(name);
      if (rom === null) continue;
      const nes = Nes.power_on_from_rom(rom);
      for (let f = 0; f < frames; f++) nes.step_frame();
      tested++;
      const got = fb_hash(nes);
      if (got !== expected) {
        mismatches.push(`${name}: got 0x${got.toString(16)}, want 0x${expected.toString(16)}`);
      }
    }
    if (tested === 0) console.warn("no commercial ROMs present — render regression skipped");
    expect(mismatches).toEqual([]);
  }, 300_000);

  test.skipIf(dir === null)("savestate: deterministic across save/load on real ROMs", () => {
    let tested = 0;
    for (const name of ["Super Mario Bros. 3 (J).nes", "Final Fantasy II (J).nes", "Tetris (J).nes"]) {
      const rom = load(name);
      if (rom === null) continue;
      const nes = Nes.power_on_from_rom(rom);
      for (let i = 0; i < 120; i++) nes.step_frame();
      const snap = nes.save_state();

      for (let i = 0; i < 30; i++) nes.step_frame();
      const reference = Uint32Array.from(nes.framebuffer());

      nes.load_state(snap);
      for (let i = 0; i < 30; i++) nes.step_frame();
      expect(nes.framebuffer()).toEqual(reference);
      tested++;
    }
    if (tested === 0) console.warn("no commercial ROMs present — savestate determinism skipped");
  }, 300_000);

  // .sav（バッテリー RAM）互換: gones/rsnes/cppnes 生成の .sav を読み、往復がバイト一致。
  test.skipIf(dir === null)("compat: .sav round-trips byte-identical to gones", () => {
    const rom = load("Final Fantasy II (J).nes");
    const sav = load("Final Fantasy II (J).sav");
    if (rom === null || sav === null) return;

    const nes = Nes.power_on_from_rom(rom);
    expect(nes.has_battery()).toBe(true);
    expect(nes.battery_ram().length).toBe(sav.length);

    nes.load_battery_ram(sav);
    expect(nes.battery_ram()).toEqual(sav);
  });

  // .cht（チート）互換: gones 生成の .cht を tsnes のパーサが解釈できる。
  test.skipIf(dir === null)("compat: .cht parses gones cheat files", () => {
    const ff2 = load("Final Fantasy II (J).cht");
    if (ff2 !== null) {
      const { cheats, errors } = load_str(new TextDecoder().decode(ff2));
      expect(errors).toEqual([]);
      expect(cheats.some((c) => c.address === 0x601f && c.value === 0x07)).toBe(true);
    }
    const feg = load("Fire Emblem Gaiden (J).cht");
    if (feg !== null) {
      const { cheats, errors } = load_str(new TextDecoder().decode(feg));
      expect(errors).toEqual([]);
      expect(cheats.length).toBe(2);
    }
  });

  // チートが実際に Bus 読み出しを書き換える（統合）。
  test.skipIf(dir === null)("compat: cheat applied through Bus on real ROM", () => {
    const rom = load("Final Fantasy II (J).nes");
    if (rom === null) return;
    const nes = Nes.power_on_from_rom(rom);
    const errs = nes.load_cheats_str("0010:AB");
    expect(errs).toEqual([]);
    nes.bus.write(0x0010, 0x00);
    expect(nes.bus.read(0x0010)).toBe(0xab); // チートが RAM 読みを上書き
    nes.bus.cheats.toggle_all();
    expect(nes.bus.read(0x0010)).toBe(0x00); // 無効化で素の値
  });
});
