// 移植元 cppnes `core/tests/input_test.cpp`（さらに元は rsnes `input.rs` の tests）。
import { describe, expect, test } from "bun:test";
import { BUTTON_A, BUTTON_B, BUTTON_SELECT, Controller } from "../src/core/input.ts";

describe("controller", () => {
  // 標準ポーリング: strobe 1→0 後、A,B,Select,... の順に 1 ビットずつ。
  test("serial read sequence after strobe", () => {
    const c = new Controller();
    c.set_button(0, BUTTON_B, true);
    c.set_button(0, BUTTON_SELECT, true);
    c.write(1); // strobe high
    c.write(0); // strobe low

    const expected = [0, 1, 1, 0, 0, 0, 0, 0]; // A,B,Sel,Start,U,D,L,R
    for (let i = 0; i < 8; i++) {
      expect(c.read() & 1).toBe(expected[i]!);
    }
    // 8 ビット超は 1 を返す。
    expect(c.read()).toBe(1);
  });

  // strobe high の間は最初のボタン(A)を返し続ける。
  test("strobe high locks to button A", () => {
    const c = new Controller();
    c.set_button(0, BUTTON_A, true);
    c.write(1); // strobe high
    for (let i = 0; i < 5; i++) {
      expect(c.read() & 1).toBe(1);
    }
    c.write(0);
    expect(c.read() & 1).toBe(1); // A
    for (let i = 0; i < 6; i++) {
      expect(c.read() & 1).toBe(0); // 残りは未押下
    }
  });
});
