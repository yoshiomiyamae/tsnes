// 移植元 cppnes `core/tests/savestate_test.cpp`。
// StateWriter / StateReader の往復一致と EOF エラーを検証する。
import { describe, expect, test } from "bun:test";
import {
  STATE_MAGIC,
  StateError,
  StateErrorKind,
  StateReader,
  StateWriter,
} from "../src/core/savestate.ts";

describe("savestate", () => {
  test("round-trips all scalar types in LE", () => {
    const w = new StateWriter();
    w.u8(0x12);
    w.u16(0x3456);
    w.u32(0x789abcde);
    w.u64(0x0001_2345_6789_abcd); // 2^53 未満（JS の安全整数域）
    w.i32(-12345);
    w.i64(-9876543210);
    w.f32(3.5);
    w.f64(-2.25);
    w.boolean(true);
    w.boolean(false);
    w.vec(new Uint8Array([0xaa, 0xbb, 0xcc]));

    const bytes = w.into_bytes();
    const r = new StateReader(bytes);

    expect(r.u8()).toBe(0x12);
    expect(r.u16()).toBe(0x3456);
    expect(r.u32()).toBe(0x789abcde);
    expect(r.u64()).toBe(0x0001_2345_6789_abcd);
    expect(r.i32()).toBe(-12345);
    expect(r.i64()).toBe(-9876543210);
    expect(r.f32()).toBe(3.5);
    expect(r.f64()).toBe(-2.25);
    expect(r.boolean()).toBe(true);
    expect(r.boolean()).toBe(false);
    expect([...r.vec()]).toEqual([0xaa, 0xbb, 0xcc]);
    expect(r.remaining()).toBe(0);
  });

  test("u16 is written little-endian", () => {
    const w = new StateWriter();
    w.u16(0x3456);
    const bytes = w.into_bytes();
    expect(bytes.length).toBe(2);
    expect(bytes[0]).toBe(0x56); // LE: low byte first
    expect(bytes[1]).toBe(0x34);
  });

  test('magic constant encodes to "RSST"', () => {
    const w = new StateWriter();
    w.u32(STATE_MAGIC);
    const bytes = w.into_bytes();
    expect(bytes.length).toBe(4);
    expect(String.fromCharCode(...bytes)).toBe("RSST");
  });

  test("f32 rounds to single precision like C++ float", () => {
    const w = new StateWriter();
    w.f32(0.1);
    const r = new StateReader(w.into_bytes());
    expect(r.f32()).toBe(Math.fround(0.1));
  });

  test("reading past the end yields UnexpectedEof", () => {
    const r = new StateReader(new Uint8Array([0x01]));
    expect(r.u8()).toBe(0x01);
    try {
      r.u8();
      throw new Error("expected StateError");
    } catch (e) {
      expect(e).toBeInstanceOf(StateError);
      expect((e as StateError).kind).toBe(StateErrorKind.UnexpectedEof);
    }
  });

  test("read_into fills a fixed-size buffer", () => {
    const w = new StateWriter();
    w.bytes(new Uint8Array([1, 2, 3, 4]));
    const r = new StateReader(w.into_bytes());
    const dst = new Uint8Array(4);
    r.read_into(dst);
    expect([...dst]).toEqual([1, 2, 3, 4]);
    expect(r.remaining()).toBe(0);
  });
});
