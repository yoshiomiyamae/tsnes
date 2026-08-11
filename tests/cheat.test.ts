// 移植元 cppnes `core/tests/cheat_test.cpp`（さらに元は rsnes `cheat.rs` tests）。
import { describe, expect, test } from "bun:test";
import { Bus } from "../src/core/bus.ts";
import { CheatManager, decode_game_genie, load_str, parse_line } from "../src/core/cheat.ts";

describe("cheat", () => {
  test("raw poke", () => {
    const c = parse_line("601F:07");
    expect(c.address).toBe(0x601f);
    expect(c.value).toBe(0x07);
    expect(c.has_compare).toBe(false);
  });

  test("raw poke with compare", () => {
    const c = parse_line("00FF:12:34");
    expect(c.address).toBe(0x00ff);
    expect(c.value).toBe(0x12);
    expect(c.compare).toBe(0x34);
    expect(c.has_compare).toBe(true);
  });

  test("clear empties cheats but keeps enabled flag", () => {
    const m = new CheatManager();
    m.load_str("6100:0C\n6102:08\n");
    expect(m.count()).toBe(2);
    m.toggle_all(); // グローバル無効化。
    expect(m.enabled()).toBe(false);

    m.clear();
    expect(m.count()).toBe(0);
    expect(m.is_empty()).toBe(true);
    expect(m.enabled()).toBe(false); // 有効/無効状態は clear で保持される。

    // リロード相当: 作り直しても二重登録にならない。
    m.load_str("6100:0C\n");
    expect(m.count()).toBe(1);
  });

  test("Game Genie 6-char", () => {
    const c = decode_game_genie("SXIOPO");
    expect(c.address).toBeGreaterThanOrEqual(0x8000);
    expect(c.has_compare).toBe(false);
  });

  test("Game Genie 8-char has compare", () => {
    const c = decode_game_genie("GZEEAPNL");
    expect(c.has_compare).toBe(true);
  });

  test("invalid code is rejected", () => {
    expect(() => decode_game_genie("ABC")).toThrow(); // 長さ不正
    expect(() => decode_game_genie("BBBBBB!")).toThrow(); // 不正文字（7 文字）
  });

  test("load multiline with comments", () => {
    const text = "030F:63\n0333:63 # max stat\n\n# comment line\n";
    const { cheats, errors } = load_str(text);
    expect(errors).toEqual([]);
    expect(cheats.length).toBe(2);
    expect(cheats[0]!.address).toBe(0x030f);
    expect(cheats[1]!.address).toBe(0x0333);
    expect(cheats[1]!.comment).toBe("max stat");
  });

  test("manager apply + toggle", () => {
    const m = new CheatManager();
    m.add(parse_line("0010:42"));
    expect(m.apply(0x0010, 0x00)).toBe(0x42); // パッチ
    expect(m.apply(0x0011, 0x99)).toBe(0x99); // 非対象
    m.toggle_all();
    expect(m.apply(0x0010, 0x00)).toBe(0x00); // 無効化
  });

  test("manager apply with compare", () => {
    const m = new CheatManager();
    m.add(parse_line("0010:42:55"));
    expect(m.apply(0x0010, 0x55)).toBe(0x42); // compare 一致 → パッチ
    expect(m.apply(0x0010, 0x00)).toBe(0x00); // compare 不一致 → 素通し
  });

  // ---- 以下は tsnes 追加分（cppnes の CheatManager には無い個別操作）----

  test("set_enabled で個別に有効/無効を切り替えられる", () => {
    const m = new CheatManager();
    m.add(parse_line("0010:42"));
    m.add(parse_line("0020:43"));
    expect(m.apply(0x0010, 0x00)).toBe(0x42);
    m.set_enabled(0, false);
    expect(m.apply(0x0010, 0x00)).toBe(0x00); // 無効化した方だけ素通し
    expect(m.apply(0x0020, 0x00)).toBe(0x43); // もう一方は効いたまま
    m.set_enabled(0, true);
    expect(m.apply(0x0010, 0x00)).toBe(0x42);
  });

  test("set_enabled は範囲外を無視する", () => {
    const m = new CheatManager();
    m.add(parse_line("0010:42"));
    m.set_enabled(5, false);
    m.set_enabled(-1, false);
    expect(m.apply(0x0010, 0x00)).toBe(0x42);
  });

  test("remove で 1 件だけ削除できる", () => {
    const m = new CheatManager();
    m.add(parse_line("0010:42"));
    m.add(parse_line("0020:43"));
    m.remove(0);
    expect(m.count()).toBe(1);
    expect(m.apply(0x0010, 0x00)).toBe(0x00);
    expect(m.apply(0x0020, 0x00)).toBe(0x43);
    m.remove(9); // 範囲外は no-op
    expect(m.count()).toBe(1);
  });

  test("to_cht_text は .cht として読み直せる形に書き出す", () => {
    const m = new CheatManager();
    m.load_str("0010:42 # first\nSXIOPO\n");
    const text = m.to_cht_text();
    const round = new CheatManager();
    const errs = round.load_str(text);
    expect(errs).toEqual([]);
    expect(round.count()).toBe(2);
    expect(round.list()[0]!.address).toBe(m.list()[0]!.address);
    expect(round.list()[0]!.value).toBe(m.list()[0]!.value);
    expect(round.list()[0]!.comment).toBe("first");
    expect(round.list()[1]!.address).toBe(m.list()[1]!.address);
  });

  // Bus.read がチートパッチを適用する（is_empty()/apply() の統合経路）。
  test("Bus.read applies patches", () => {
    const bus = new Bus();
    bus.ram[0x10] = 0x00;
    expect(bus.read(0x0010)).toBe(0x00); // チート無し → 素通し
    const errs = bus.cheats.load_str("0010:42");
    expect(errs).toEqual([]);
    expect(bus.read(0x0010)).toBe(0x42); // RAM は 0x00 だがチートが 0x42 を返す
    bus.cheats.toggle_all();
    expect(bus.read(0x0010)).toBe(0x00); // 無効化で素通しに戻る
  });
});
