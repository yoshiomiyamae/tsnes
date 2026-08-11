// hexdump.ts（ヘックスダンプ整形・カラム計算）の単体テスト
// （移植元 cppnes `core/tests/hexdump_test.cpp`）。
import { describe, expect, test } from "bun:test";
import {
  ByteClass,
  classify_byte,
  format_addr,
  format_p_flags,
  hex_ascii_col,
  hex_byte,
  hex_byte_col,
  hex_digit,
  hex_line_cols,
  printable,
} from "../src/web/hexdump.ts";

describe("hexdump", () => {
  test("hex_digit maps nibble to uppercase hex", () => {
    expect(hex_digit(0x0)).toBe("0");
    expect(hex_digit(0x9)).toBe("9");
    expect(hex_digit(0xa)).toBe("A");
    expect(hex_digit(0xf)).toBe("F");
    // 下位 4 ビットのみ使用。
    expect(hex_digit(0x1f)).toBe("F");
  });

  test("hex_byte formats a byte as two hex chars", () => {
    expect(hex_byte(0x00)).toBe("00");
    expect(hex_byte(0xab)).toBe("AB");
    expect(hex_byte(0x3c)).toBe("3C");
    expect(hex_byte(0xff)).toBe("FF");
  });

  test("format_addr renders $XXXX: label", () => {
    expect(format_addr(0x0000)).toBe("$0000:");
    expect(format_addr(0x07ff)).toBe("$07FF:");
    expect(format_addr(0xbeef)).toBe("$BEEF:");
  });

  test("hex_byte_col matches the rendered layout", () => {
    // "$XXXX: " = 7 セル、以後 3 セル刻み、8 バイト目の前に区切り +1。
    expect(hex_byte_col(0)).toBe(7);
    expect(hex_byte_col(1)).toBe(10);
    expect(hex_byte_col(7)).toBe(28);
    expect(hex_byte_col(8)).toBe(32); // 区切りで +1
    expect(hex_byte_col(15)).toBe(53);
  });

  test("ascii column and line width are derived consistently", () => {
    expect(hex_ascii_col()).toBe(56);
    expect(hex_line_cols()).toBe(73);
  });

  test("printable maps control bytes to dot", () => {
    expect(printable(0x41)).toBe("A");
    expect(printable(0x20)).toBe(" ");
    expect(printable(0x7e)).toBe("~");
    expect(printable(0x00)).toBe(".");
    expect(printable(0x7f)).toBe(".");
    expect(printable(0xff)).toBe(".");
  });

  test("classify_byte prioritizes cheat-active > cheat-set > changed > value", () => {
    // 引数順: (actual, changed, cheat_addr, cheat_active)
    // 作用中は何より優先。
    expect(classify_byte(0x00, true, true, true)).toBe(ByteClass.Cheat);
    expect(classify_byte(0x42, false, true, true)).toBe(ByteClass.Cheat);
    // 登録ありだが実体一致（active=false）→ CheatSet。changed より優先。
    expect(classify_byte(0x0c, true, true, false)).toBe(ByteClass.CheatSet);
    expect(classify_byte(0x0c, false, true, false)).toBe(ByteClass.CheatSet);
    // チート番地でなければ変化が優先。
    expect(classify_byte(0x42, true, false, false)).toBe(ByteClass.Changed);
    // 変化もチートも無ければゼロ/非ゼロ。
    expect(classify_byte(0x00, false, false, false)).toBe(ByteClass.Zero);
    expect(classify_byte(0x01, false, false, false)).toBe(ByteClass.Value);
  });

  test("format_p_flags renders NV-BDIZC with case by bit", () => {
    // bit5 は常に '-'。
    expect(format_p_flags(0x00)).toBe("nv-bdizc");
    expect(format_p_flags(0xff)).toBe("NV-BDIZC");
    // Carry のみ（bit0）。
    expect(format_p_flags(0x01)).toBe("nv-bdizC");
    // Negative のみ（bit7）。
    expect(format_p_flags(0x80)).toBe("Nv-bdizc");
    // Zero(bit1) + Interrupt(bit2)。
    expect(format_p_flags(0x06)).toBe("nv-bdIZc");
  });
});
