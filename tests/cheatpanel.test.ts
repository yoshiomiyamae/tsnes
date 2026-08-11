// チート編集パネル（src/web/cheatpanel.ts）のロジック検証。
// DOM は tests/dom_stub.ts の最小スタブで代用する。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Nes } from "../src/core/nes.ts";
import { type StubElement, install_dom, make_root, uninstall_dom } from "./dom_stub.ts";

beforeAll(install_dom);
afterAll(uninstall_dom);

function build_rom(): Uint8Array {
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
  rom[16 + 0x3ffc] = 0x00;
  rom[16 + 0x3ffd] = 0x80;
  return rom;
}

async function make() {
  const { CheatPanel } = await import("../src/web/cheatpanel.ts");
  const root = make_root();
  const panel = new CheatPanel(root as unknown as HTMLElement);
  const nes = Nes.power_on_from_rom(build_rom());
  panel.attach(nes);
  panel.open();
  return { panel, nes, root };
}

// 入力欄（type=text）を取り出す（0=コード, 1=コメント）。
function inputs(root: StubElement): StubElement[] {
  return root.find_all("input").filter((e) => e.type === "text");
}
function checkboxes(root: StubElement): StubElement[] {
  return root.find_all("input").filter((e) => e.type === "checkbox");
}
function buttons(root: StubElement): StubElement[] {
  return root.find_all("button");
}

describe("CheatPanel", () => {
  test("raw poke を追加すると Bus の読み値が置き換わる", async () => {
    const { panel, nes, root } = await make();
    const [code, comment] = inputs(root);
    code!.value = "0010:42";
    comment!.value = "テスト";
    panel.add_from_input();

    expect(nes.bus.cheats.count()).toBe(1);
    nes.bus.write(0x0010, 0x00);
    expect(nes.bus.read(0x0010)).toBe(0x42);
    expect(nes.bus.cheats.list()[0]!.comment).toBe("テスト");
    // 入力欄はクリアされる。
    expect(code!.value).toBe("");
  });

  test("Game Genie コードも追加できる", async () => {
    const { panel, nes, root } = await make();
    inputs(root)[0]!.value = "SXIOPO";
    panel.add_from_input();
    expect(nes.bus.cheats.count()).toBe(1);
    expect(nes.bus.cheats.list()[0]!.address).toBeGreaterThanOrEqual(0x8000);
  });

  test("不正なコードはエラー表示して登録しない", async () => {
    const { panel, nes, root } = await make();
    inputs(root)[0]!.value = "ZZZ";
    panel.add_from_input();
    expect(nes.bus.cheats.count()).toBe(0);
    expect(root.walk().some((e) => e.className === "cp-msg" && e.textContent.includes("不正"))).toBe(
      true,
    );
  });

  test("チェックボックスで個別に無効化できる", async () => {
    const { panel, nes, root } = await make();
    inputs(root)[0]!.value = "0010:42";
    panel.add_from_input();
    nes.bus.write(0x0010, 0x00);
    expect(nes.bus.read(0x0010)).toBe(0x42);

    const box = checkboxes(root)[0]!;
    box.checked = false;
    box.fire("change");
    expect(nes.bus.read(0x0010)).toBe(0x00);

    const box2 = checkboxes(root)[0]!;
    box2.checked = true;
    box2.fire("change");
    expect(nes.bus.read(0x0010)).toBe(0x42);
  });

  test("削除ボタンで 1 件消える", async () => {
    const { panel, nes, root } = await make();
    inputs(root)[0]!.value = "0010:42";
    panel.add_from_input();
    inputs(root)[0]!.value = "0020:43";
    panel.add_from_input();
    expect(nes.bus.cheats.count()).toBe(2);

    const del = buttons(root).find((b) => b.dataset.del === "0")!;
    del.fire("click");
    expect(nes.bus.cheats.count()).toBe(1);
    expect(nes.bus.cheats.list()[0]!.address).toBe(0x0020);
  });

  test("全体トグルで一括無効化でき、表示も切り替わる", async () => {
    const { panel, nes, root } = await make();
    inputs(root)[0]!.value = "0010:42";
    panel.add_from_input();

    const toggle = buttons(root).find((b) => b.textContent.startsWith("全体"))!;
    expect(toggle.textContent).toBe("全体: 有効");
    toggle.fire("click");
    expect(nes.bus.cheats.enabled()).toBe(false);
    nes.bus.write(0x0010, 0x00);
    expect(nes.bus.read(0x0010)).toBe(0x00);
    const toggle2 = buttons(root).find((b) => b.textContent.startsWith("全体"))!;
    expect(toggle2.textContent).toBe("全体: 無効");
  });

  test("変更のたびに on_change が呼ばれる（永続化フック）", async () => {
    const { panel, root } = await make();
    let calls = 0;
    panel.on_change = () => calls++;
    inputs(root)[0]!.value = "0010:42";
    panel.add_from_input();
    expect(calls).toBe(1);
    checkboxes(root)[0]!.fire("change");
    expect(calls).toBe(2);
    buttons(root).find((b) => b.dataset.del === "0")!.fire("click");
    expect(calls).toBe(3);
  });

  test("未登録なら案内文を出す", async () => {
    const { root } = await make();
    expect(root.walk().some((e) => e.textContent.includes("チート未登録"))).toBe(true);
  });
});
