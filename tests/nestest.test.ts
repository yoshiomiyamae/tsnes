// nestest CPU 検証（移植元 cppnes `core/tests/nestest.cpp`）。
//
// nestest.nes を $C000 から自動モードで実行し、実機準拠の nestest.log と 1 命令ごとに
// レジスタ状態（PC/A/X/Y/P/SP/CYC）を照合する。公式・非公式命令、ページ跨ぎ、ダミー
// 読み、サイクル数まで一括検証できる CPU の決定版テスト（8991 行一致）。
import { describe, expect, test } from "bun:test";
import { Bus } from "../src/core/bus.ts";
import { Cartridge } from "../src/core/cartridge.ts";
import { Cpu } from "../src/core/cpu.ts";
import { read_file, test_roms_dir } from "./common.ts";

interface Expected {
  pc: number;
  a: number;
  x: number;
  y: number;
  p: number;
  sp: number;
  cyc: number;
}

function parse_log_line(line: string): Expected {
  const e: Expected = { pc: 0, a: 0, x: 0, y: 0, p: 0, sp: 0, cyc: 0 };
  e.pc = parseInt(line.slice(0, 4), 16);
  for (const tok of line.split(/\s+/)) {
    if (tok.startsWith("A:")) e.a = parseInt(tok.slice(2), 16);
    else if (tok.startsWith("X:")) e.x = parseInt(tok.slice(2), 16);
    else if (tok.startsWith("Y:")) e.y = parseInt(tok.slice(2), 16);
    else if (tok.startsWith("SP:")) e.sp = parseInt(tok.slice(3), 16);
    else if (tok.startsWith("P:")) e.p = parseInt(tok.slice(2), 16);
    else if (tok.startsWith("CYC:")) e.cyc = parseInt(tok.slice(4), 10);
  }
  return e;
}

describe("nestest", () => {
  const dir = test_roms_dir();
  const rom = dir ? read_file(dir, "other", "nestest.nes") : null;
  const log = dir ? read_file(dir, "other", "nestest.log") : null;

  test.skipIf(!rom || !log)("matches reference log line-by-line", () => {
    const cart = Cartridge.from_bytes(rom!);
    const bus = new Bus();
    bus.set_cartridge(cart);

    // 自動モード: $C000 から開始、P=$24 (U|I)、SP=$FD、CYC=7。
    const cpu = new Cpu();
    cpu.pc = 0xc000;
    cpu.sp = 0xfd;
    cpu.p = 0x24;
    cpu.cycles = 7;

    const log_text = new TextDecoder().decode(log!);
    let lineno = 0;
    for (let raw of log_text.split("\n")) {
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (raw.length === 0) continue;
      lineno++;
      const exp = parse_log_line(raw);
      const actual = {
        pc: cpu.pc,
        a: cpu.a,
        x: cpu.x,
        y: cpu.y,
        p: cpu.p,
        sp: cpu.sp,
        cyc: cpu.cycles,
      };
      if (
        actual.pc !== exp.pc ||
        actual.a !== exp.a ||
        actual.x !== exp.x ||
        actual.y !== exp.y ||
        actual.p !== exp.p ||
        actual.sp !== exp.sp ||
        actual.cyc !== exp.cyc
      ) {
        throw new Error(
          `line ${lineno} mismatch\n  log: ${raw}\n  exp: ${JSON.stringify(exp)}\n  got: ${JSON.stringify(actual)}`,
        );
      }
      cpu.step(bus);
    }
    expect(lineno).toBe(8991);
  });
});
