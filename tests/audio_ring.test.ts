// AudioWorklet のリングバッファ/リサンプラ単体テスト。
//
// ワークレット本体は文字列ではなく実モジュール（src/web/audio-worklet.ts）なので、
// AudioWorklet API 無しでもこのクラスだけ検証できる。
import { describe, expect, test } from "bun:test";
import { RingResampler } from "../src/web/audio-worklet.ts";

describe("RingResampler", () => {
  test("同レートならサンプルをそのまま返す", () => {
    const r = new RingResampler(44100, 44100);
    r.push(Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]));
    const out = new Float32Array(3);
    r.fill(out);
    expect(Array.from(out).map((v) => Math.round(v * 10) / 10)).toEqual([0.1, 0.2, 0.3]);
    expect(r.available).toBe(2);
  });

  test("2 倍レートのコンテキストでは線形補間で中間値を返す", () => {
    const r = new RingResampler(22050, 44100); // ratio = 0.5
    r.push(Float32Array.from([0, 1, 2, 3]));
    const out = new Float32Array(4);
    r.fill(out);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1.5]);
  });

  test("アンダーラン時は直近値を保持する（無音のクリックを出さない）", () => {
    const r = new RingResampler(44100, 44100);
    r.push(Float32Array.from([0.5, 0.5]));
    const out = new Float32Array(4);
    r.fill(out);
    // 2 サンプルしか無いので、補間に必要な 2 個を割った時点で保持へ切り替わる。
    expect(out[0]).toBe(0.5);
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBe(0.5);
    expect(out[3]).toBe(0.5);
  });

  test("データが無ければ 0 を出す", () => {
    const r = new RingResampler(44100, 44100);
    const out = new Float32Array(2);
    r.fill(out);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  test("容量を超えて溜めると古い分を捨てて破綻しない", () => {
    const size = 1 << 8;
    const r = new RingResampler(44100, 44100, size);
    r.push(new Float32Array(size * 2).fill(0.25));
    expect(r.available).toBeLessThan(size);
    const out = new Float32Array(16);
    r.fill(out);
    expect(Array.from(out).every((v) => v === 0.25)).toBe(true);
  });
});
