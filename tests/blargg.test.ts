// blargg 形式テスト ROM ハーネス + PPU/VBL/NMI + MMC3 IRQ スイート
// （移植元 cppnes `core/tests/blargg.cpp`）。
//
// ステータスを $6000、ASCII テキストを $6004+ に書く blargg プロトコルで合否判定し、
// Nes を駆動して CPU+PPU+NMI/IRQ 統合を実機 ROM で検証する。
import { describe, expect, test } from "bun:test";
import { Nes } from "../src/core/nes.ts";
import { read_file, test_roms_dir } from "./common.ts";

const STATUS_ADDR = 0x6000;
const SIG_ADDR = 0x6001;
const TEXT_ADDR = 0x6004;
const RUN_FLAG = 0x80;
const RESET_FLAG = 0x81;

interface BlarggResult {
  status: number;
  text: string;
  frames: number;
  loaded: boolean;
}

function run_blargg_test(rom: Uint8Array, max_frames: number): BlarggResult {
  const r: BlarggResult = { status: 0, text: "", frames: 0, loaded: false };
  let nes: Nes;
  try {
    nes = Nes.power_on_from_rom(rom);
  } catch {
    return r;
  }
  r.loaded = true;

  let signature_seen = false;
  let prev_status = 0;
  while (r.frames < max_frames) {
    nes.step_frame();

    if (
      nes.bus.read(SIG_ADDR) === 0xde &&
      nes.bus.read(SIG_ADDR + 1) === 0xb0 &&
      nes.bus.read(SIG_ADDR + 2) === 0x61
    ) {
      signature_seen = true;
    }
    r.status = nes.bus.read(STATUS_ADDR);

    if (signature_seen) {
      const is_reset = r.status === RESET_FLAG;
      if (is_reset && prev_status !== RESET_FLAG) {
        nes.soft_reset();
      }
      prev_status = r.status;
      if (!is_reset) {
        if (r.status < RUN_FLAG && r.status !== 0x00) break; // 完了（エラー）
        if (r.status === 0x00 && r.frames > 60) break; // 完了（成功）
      }
    }
    r.frames++;
  }

  const chars: string[] = [];
  for (let i = 0; i < 0x2000; i++) {
    const c = nes.bus.read((TEXT_ADDR + i) & 0xffff);
    if (c === 0) break;
    if (c >= 0x20 && c < 0x7f) chars.push(String.fromCharCode(c));
    else if (c === 0x0a) chars.push("\n");
  }
  r.text = chars.join("");
  return r;
}

interface BlarggCase {
  name: string;
  max_frames: number;
  expected_to_pass: boolean;
}

// スイートを走らせ、期待に反したものの一覧を返す（tested===0 なら null＝skip 扱い）。
function run_blargg_suite(subdir: string, cases: BlarggCase[]): string[] | null {
  const dir = test_roms_dir();
  if (dir === null) return null;

  const failures: string[] = [];
  let tested = 0;
  for (const c of cases) {
    const rom = read_file(dir, ...subdir.split("/"), c.name);
    if (rom === null) continue; // skip (missing)
    const res = run_blargg_test(rom, c.max_frames);
    if (!res.loaded) continue; // skip (load failed)
    tested++;
    const passed = res.status === 0x00 && res.text.toLowerCase().includes("passed");
    if (c.expected_to_pass && !passed) {
      failures.push(`${c.name}: expected pass, status=${res.status} text="${res.text}"`);
    }
  }
  if (tested === 0) return null;
  return failures;
}

const roms_present = test_roms_dir() !== null;

describe("blargg", () => {
  test.skipIf(!roms_present)("ppu_vbl_nmi", () => {
    // 07/10 は whole-instruction stepping の限界で既知失敗（cppnes/rsnes と同じ）。
    const failures = run_blargg_suite("ppu_vbl_nmi/rom_singles", [
      { name: "01-vbl_basics.nes", max_frames: 600, expected_to_pass: true },
      { name: "02-vbl_set_time.nes", max_frames: 600, expected_to_pass: true },
      { name: "03-vbl_clear_time.nes", max_frames: 600, expected_to_pass: true },
      { name: "04-nmi_control.nes", max_frames: 600, expected_to_pass: true },
      { name: "05-nmi_timing.nes", max_frames: 600, expected_to_pass: true },
      { name: "06-suppression.nes", max_frames: 600, expected_to_pass: true },
      { name: "07-nmi_on_timing.nes", max_frames: 600, expected_to_pass: false },
      { name: "08-nmi_off_timing.nes", max_frames: 600, expected_to_pass: true },
      { name: "09-even_odd_frames.nes", max_frames: 600, expected_to_pass: true },
      { name: "10-even_odd_timing.nes", max_frames: 600, expected_to_pass: false },
    ]);
    expect(failures ?? []).toEqual([]);
  }, 120_000);

  test.skipIf(!roms_present)("mmc3_test (IRQ/banking)", () => {
    // 6-MMC6 は MMC6/NEC-MMC3 変種で Sharp MMC3 と衝突するため既知失敗（cppnes/rsnes と同じ）。
    const failures = run_blargg_suite("mmc3_test", [
      { name: "1-clocking.nes", max_frames: 600, expected_to_pass: true },
      { name: "2-details.nes", max_frames: 1200, expected_to_pass: true },
      { name: "3-A12_clocking.nes", max_frames: 600, expected_to_pass: true },
      { name: "4-scanline_timing.nes", max_frames: 1800, expected_to_pass: true },
      { name: "5-MMC3.nes", max_frames: 1800, expected_to_pass: true },
      { name: "6-MMC6.nes", max_frames: 1200, expected_to_pass: false },
    ]);
    expect(failures ?? []).toEqual([]);
  }, 300_000);

  // CPU 命令セット（instr_test-v5、MMC1 = Mapper1）。
  // 07-abs_xy は未実装の不安定命令 SYA/SXA($9C/$9E)のため既知失敗。
  // cppnes も同じ結果になることを tools/diff_cppnes.sh（900 フレーム、
  // フレームバッファ完全一致）で確認済み。
  test.skipIf(!roms_present)("instr_test-v5 (official + illegal opcodes)", () => {
    const failures = run_blargg_suite("instr_test-v5/rom_singles", [
      { name: "01-basics.nes", max_frames: 600, expected_to_pass: true },
      { name: "02-implied.nes", max_frames: 600, expected_to_pass: true },
      { name: "03-immediate.nes", max_frames: 900, expected_to_pass: true },
      { name: "04-zero_page.nes", max_frames: 900, expected_to_pass: true },
      { name: "05-zp_xy.nes", max_frames: 900, expected_to_pass: true },
      { name: "06-absolute.nes", max_frames: 900, expected_to_pass: true },
      { name: "07-abs_xy.nes", max_frames: 1200, expected_to_pass: false },
      { name: "08-ind_x.nes", max_frames: 900, expected_to_pass: true },
      { name: "09-ind_y.nes", max_frames: 900, expected_to_pass: true },
      { name: "10-branches.nes", max_frames: 600, expected_to_pass: true },
      { name: "11-stack.nes", max_frames: 900, expected_to_pass: true },
      { name: "12-jmp_jsr.nes", max_frames: 600, expected_to_pass: true },
      { name: "13-rts.nes", max_frames: 600, expected_to_pass: true },
      { name: "14-rti.nes", max_frames: 600, expected_to_pass: true },
      { name: "15-brk.nes", max_frames: 600, expected_to_pass: true },
      { name: "16-special.nes", max_frames: 600, expected_to_pass: true },
    ]);
    expect(failures ?? []).toEqual([]);
  }, 600_000);

  // CPU 割り込み（cpu_interrupts_v2、MMC1）。命令単位ステッピングの限界で
  // 2 / 3 / 4 / 5 は既知失敗（cppnes と同一挙動を差分検証済み）。
  test.skipIf(!roms_present)("cpu_interrupts_v2", () => {
    const failures = run_blargg_suite("cpu_interrupts_v2/rom_singles", [
      { name: "1-cli_latency.nes", max_frames: 600, expected_to_pass: true },
      { name: "2-nmi_and_brk.nes", max_frames: 900, expected_to_pass: false },
      { name: "3-nmi_and_irq.nes", max_frames: 900, expected_to_pass: false },
      { name: "4-irq_and_dma.nes", max_frames: 900, expected_to_pass: false },
      { name: "5-branch_delays_irq.nes", max_frames: 900, expected_to_pass: false },
    ]);
    expect(failures ?? []).toEqual([]);
  }, 600_000);
});
