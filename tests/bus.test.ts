// 移植元 cppnes `core/tests/bus_test.cpp`（さらに元は rsnes `bus.rs` の tests）。
import { describe, expect, test } from "bun:test";
import { Bus, OAM_DMA_STALL_CYCLES } from "../src/core/bus.ts";
import { BUTTON_A, BUTTON_B } from "../src/core/input.ts";
import { StateReader, StateWriter } from "../src/core/savestate.ts";

describe("bus", () => {
  // PPU/APU/Input/Cartridge 未接続時の open-bus フォールバック経路を覆う。
  test("read with unconnected components falls back to open-bus", () => {
    const m = new Bus();

    // RAM は常に存在しバスをラッチする。
    m.ram[0x10] = 0x42;
    expect(m.read(0x0010)).toBe(0x42);
    expect(m.read(0x0810)).toBe(0x42); // $0010 のミラー

    // 未接続デバイスへの読みはクラッシュせず open-bus ラッチ値を返す。
    m.read(0x2000); // PPU（カートリッジなし）
    m.read(0x4015); // APU
    m.read(0x4016); // Input
    m.read(0x4000); // 書き込み専用ポート
    m.read(0x401f); // 未割り当て窓
    m.read(0x5000); // 拡張カートリッジなし
  });

  // カートリッジ未接続時、$6000-$FFFF は HighMem がバッキングする。
  test("high-mem fallback backs $6000-$FFFF without a cartridge", () => {
    const m = new Bus();
    m.write(0x6000, 0xab);
    expect(m.read(0x6000)).toBe(0xab);
    m.write(0xc123, 0xcd);
    expect(m.read(0xc123)).toBe(0xcd);
  });

  // 未接続デバイスへの書き込みは安全な no-op。OAM DMA は PPU 不在でもストールを課す。
  test("write to unconnected components is a safe no-op", () => {
    const m = new Bus();
    m.write(0x2000, 0x01); // PPU なし
    m.write(0x4000, 0x02); // APU なし
    m.write(0x4016, 0x03); // Input なし
    m.write(0x5000, 0x04); // 拡張カートリッジなし

    expect(m.write(0x4014, 0x00)).toBe(OAM_DMA_STALL_CYCLES);
  });

  // 2 コントローラ: $4016=1P, $4017=2P へシリアル読みが振り分けられる。
  test("two controllers route to $4016 (1P) and $4017 (2P)", () => {
    const m = new Bus();
    m.input[0]!.set_button(0, BUTTON_A, true); // 1P: A
    m.input[1]!.set_button(0, BUTTON_B, true); // 2P: B
    m.write(0x4016, 1); // 両コントローラをストローブ
    m.write(0x4016, 0);
    expect(m.read(0x4016) & 1).toBe(1); // 1P bit0 = A
    expect(m.read(0x4017) & 1).toBe(0); // 2P bit0 = A（未押下）
    expect(m.read(0x4017) & 1).toBe(1); // 2P bit1 = B
  });

  test("save/load state round-trips RAM", () => {
    const m = new Bus();
    m.ram[5] = 0x99;
    const w = new StateWriter();
    m.save_state(w);
    const buf = w.into_bytes();

    const m2 = new Bus();
    m2.load_state(new StateReader(buf));
    expect(m2.ram[5]).toBe(0x99);
  });
});
