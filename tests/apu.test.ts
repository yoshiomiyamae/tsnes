// APU ユニットテスト（移植元 cppnes `core/tests/apu_test.cpp`）。
import { describe, expect, test } from "bun:test";
import {
  Apu,
  LENGTH_TABLE,
  NOISE_PERIODS,
  get_frequency,
  get_period,
  step_envelope,
  step_length_counter,
} from "../src/core/apu.ts";
import type { Cartridge } from "../src/core/cartridge.ts";

function create_test_apu(): Apu {
  const a = new Apu();
  a.reset();
  return a;
}

const cart: Cartridge | null = null;

describe("apu", () => {
  test("creation", () => {
    const a = create_test_apu();
    expect(a.cycles).toBe(0);
    expect(a.frame_step).toBe(0);
    expect(a.frame_irq).toBe(false);
  });

  test("pulse channel registers", () => {
    const a = create_test_apu();
    a.write_register(0x4000, 0xbf);
    expect(a.pulse1.duty_cycle).toBe(2);
    expect(a.pulse1.length.halt).toBe(true);
    expect(a.pulse1.envelope.constant).toBe(true);
    expect(a.pulse1.volume).toBe(15);

    a.write_register(0x4001, 0x88);
    expect(a.pulse1.sweep.enabled).toBe(true);
    expect(a.pulse1.sweep.period).toBe(0);
    expect(a.pulse1.sweep.negate).toBe(true);

    a.write_register(0x4002, 0x55);
    a.write_register(0x4003, 0x12);
    expect(a.pulse1.timer_value).toBe(0x255);
  });

  test("triangle channel registers", () => {
    const a = create_test_apu();
    a.write_register(0x4015, 0x04);
    a.write_register(0x4008, 0x81);
    expect(a.triangle.length.halt).toBe(true);
    expect(a.triangle.linear_counter).toBe(0);
    a.write_register(0x400a, 0xaa);
    a.write_register(0x400b, 0x13);
    expect(a.triangle.timer_value).toBe(0x3aa);
  });

  test("noise channel registers", () => {
    const a = create_test_apu();
    a.write_register(0x400c, 0x3a);
    expect(a.noise.length.halt).toBe(true);
    expect(a.noise.envelope.constant).toBe(true);
    expect(a.noise.volume).toBe(10);
    a.write_register(0x400e, 0x8f);
    expect(a.noise.mode).toBe(true);
    expect(a.noise.timer_value).toBe(NOISE_PERIODS[15]!);
  });

  test("status register enable/disable", () => {
    const a = create_test_apu();
    a.write_register(0x4015, 0x1f);
    expect(a.pulse1.enabled).toBe(true);
    expect(a.pulse2.enabled).toBe(true);
    expect(a.triangle.enabled).toBe(true);
    expect(a.noise.enabled).toBe(true);
    expect(a.dmc.enabled).toBe(true);
    a.write_register(0x4015, 0x00);
    expect(a.pulse1.enabled).toBe(false);
    expect(a.triangle.enabled).toBe(false);
  });

  test("envelope generator", () => {
    const a = create_test_apu();
    a.write_register(0x4000, 0x08);
    a.write_register(0x4003, 0x08);
    expect(a.pulse1.envelope.counter).toBe(0);
    for (let i = 0; i < 16; i++) step_envelope(a.pulse1.envelope);
    expect(a.pulse1.envelope.counter).toBe(14);
  });

  test("length counter decrements", () => {
    const a = create_test_apu();
    a.write_register(0x4015, 0x01);
    a.write_register(0x4003, 0x08);
    expect(a.pulse1.length.value).toBe(LENGTH_TABLE[1]!);
    const original = a.pulse1.length.value;
    step_length_counter(a.pulse1.length);
    expect(a.pulse1.length.value).toBe(original - 1);
  });

  test("sweep unit raises timer", () => {
    const a = create_test_apu();
    a.write_register(0x4001, 0x81);
    a.write_register(0x4002, 0x00);
    a.write_register(0x4003, 0x01);
    const original = a.pulse1.timer_value;
    a.step_sweeps();
    expect(a.pulse1.timer_value).toBeGreaterThan(original);
  });

  test("frame counter reset on write", () => {
    const a = create_test_apu();
    a.write_register(0x4017, 0x00);
    expect(a.frame_step).toBe(0);
    a.write_register(0x4017, 0x80);
    expect(a.frame_step).toBe(0);
  });

  test("channel output gating", () => {
    const a = create_test_apu();
    a.write_register(0x4015, 0x01);
    a.write_register(0x4000, 0x5f);
    a.write_register(0x4002, 0x00);
    a.write_register(0x4003, 0x01);
    a.pulse1.sequence = 1;
    expect(a.get_pulse_output(a.pulse1)).not.toBe(0);
    a.write_register(0x4015, 0x00);
    expect(a.get_pulse_output(a.pulse1)).toBe(0);
  });

  test("audio mixing stays in range", () => {
    const a = create_test_apu();
    a.write_register(0x4015, 0x1f);
    a.write_register(0x4000, 0x1f);
    a.write_register(0x4004, 0x1f);
    a.write_register(0x4008, 0x81);
    a.write_register(0x400c, 0x1f);
    const sample = a.mix_channels(0);
    expect(sample).toBeGreaterThanOrEqual(-1);
    expect(sample).toBeLessThanOrEqual(1);
  });

  test("frequency / period helpers", () => {
    const expected = Math.fround(1789773 / (16 * (0x100 + 1)));
    expect(Math.abs(get_frequency(0x100) - expected)).toBeLessThan(0.001);
    expect(get_frequency(0)).toBe(0);

    const p = get_period(440);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(0x7ff);
    expect(get_period(0)).toBe(0);
  });

  test("step advances cycles", () => {
    const a = create_test_apu();
    const initial = a.cycles;
    a.step(cart);
    expect(a.cycles).toBe(initial + 1);
  });
});
