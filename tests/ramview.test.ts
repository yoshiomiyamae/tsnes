// RAM ビューア（src/web/ramview.ts）のロジック検証。
// DOM は tests/dom_stub.ts の最小スタブで代用する。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Nes } from "../src/core/nes.ts";
import { type StubElement, install_dom, make_root, uninstall_dom } from "./dom_stub.ts";

beforeAll(install_dom);
afterAll(uninstall_dom);

// 最小 NROM（PRG RAM 8KB つき）。
function build_rom(): Uint8Array {
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
  rom[16 + 0x3ffc] = 0x00;
  rom[16 + 0x3ffd] = 0x80;
  return rom;
}

async function make() {
  const { RamViewer } = await import("../src/web/ramview.ts");
  const root = make_root();
  const rv = new RamViewer(root as unknown as HTMLElement);
  const nes = Nes.power_on_from_rom(build_rom());
  return { rv, nes, root };
}

// hex セル（data-off つき span）をオフセット順に取り出す。
function hex_cells(root: StubElement): StubElement[] {
  const cells = root.walk().filter((e) => e.dataset.off !== undefined);
  cells.sort((a, b) => Number(a.dataset.off) - Number(b.dataset.off));
  return cells;
}

describe("RamViewer", () => {
  test("開くと 2KB 分（128 行 × 16 バイト）のセルを作る", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes);
    expect(hex_cells(root).length).toBe(2048);
  });

  test("WRAM の値と ASCII を表示し、ゼロは暗色クラスになる", async () => {
    const { rv, nes, root } = await make();
    nes.bus.ram[0x10] = 0x41; // 'A'
    rv.open();
    rv.render(nes);
    const cells = hex_cells(root);
    expect(cells[0x10]!.textContent).toBe("41");
    expect(cells[0x10]!.className).toBe("b-val");
    expect(cells[0x11]!.className).toBe("b-zero");
  });

  test("前回描画から変化したバイトは changed クラスになる", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes); // 1 回目でスナップショットを取る
    nes.bus.ram[0x20] = 0x99;
    rv.render(nes);
    expect(hex_cells(root)[0x20]!.className).toBe("b-chg");
  });

  test("16 進 2 桁を打ち込むと WRAM に書き込まれ、次のバイトへ進む", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes);
    // クリック相当: 内部の編集開始をオフセット指定で呼ぶ。
    const cell = hex_cells(root)[0x30]!;
    (rv as unknown as { begin_edit(o: number): void }).begin_edit(Number(cell.dataset.off));
    expect(rv.editing).toBe(true);
    expect(rv.handle_key("a")).toBe(true);
    expect(rv.handle_key("5")).toBe(true);
    expect(nes.bus.ram[0x30]).toBe(0xa5);
    // 連続入力のため次バイトが編集対象になる。
    expect(rv.editing).toBe(true);
    expect(rv.handle_key("Escape")).toBe(true);
    expect(rv.editing).toBe(false);
  });

  test("Escape で書き込まずに取り消せる", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes);
    (rv as unknown as { begin_edit(o: number): void }).begin_edit(0x40);
    rv.handle_key("f");
    rv.handle_key("Escape");
    expect(nes.bus.ram[0x40]).toBe(0x00);
    expect(rv.editing).toBe(false);
  });

  test("領域を切り替えると PRG-RAM を表示し、そちらへ書き込む", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes);
    rv.cycle_view(1);
    rv.render(nes);
    (rv as unknown as { begin_edit(o: number): void }).begin_edit(0x05);
    rv.handle_key("7");
    rv.handle_key("e");
    expect(nes.bus.cartridge!.save_ram()[0x05]).toBe(0x7e);
    expect(nes.bus.ram[0x05]).toBe(0x00); // WRAM は触っていない
  });

  test("チート登録番地は作用中なら cheat クラスで、すり替え後の値を出す", async () => {
    const { rv, nes, root } = await make();
    nes.bus.ram[0x50] = 0x11;
    nes.load_cheats_str("0050:22");
    rv.open();
    rv.render(nes);
    const cell = hex_cells(root)[0x50]!;
    expect(cell.textContent).toBe("22"); // すり替え後の値
    expect(cell.className).toBe("b-cheat");
  });

  test("チート値が実体と一致していれば cheat-set クラス", async () => {
    const { rv, nes, root } = await make();
    nes.bus.ram[0x60] = 0x33;
    nes.load_cheats_str("0060:33");
    rv.open();
    rv.render(nes);
    expect(hex_cells(root)[0x60]!.className).toBe("b-cheatset");
  });

  test("閉じている間は描画しない", async () => {
    const { rv, nes, root } = await make();
    rv.open();
    rv.render(nes);
    rv.close();
    nes.bus.ram[0x70] = 0x77;
    rv.render(nes);
    expect(hex_cells(root)[0x70]!.textContent).toBe("00");
  });
});
