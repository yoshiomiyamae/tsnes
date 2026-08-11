// チート編集パネル。
//
// cppnes の GUI は `Ctrl+H` で `.cht` を読み直して一括 ON/OFF するだけだったが、
// ブラウザでは一覧を出して個別に追加/切替/削除できるようにする
// （コアのデコーダ・パーサ・CheatManager はそのまま使う）。
//
// 対応入力: Game Genie（6/8 文字）と raw poke `AAAA:VV[:CC]`。`.cht` の
// 書き出しは gones / rsnes / cppnes が読める形式。
import { parse_line } from "../core/cheat.ts";
import type { Nes } from "../core/nes.ts";

export class CheatPanel {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly comment: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly list_el: HTMLElement;
  private readonly toggle_all_btn: HTMLElement;
  private nes: Nes | null = null;
  // 変更されたら呼ばれる（永続化などに使う）。
  on_change: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.hidden = true;

    const form = document.createElement("div");
    form.className = "cp-form";

    this.input = document.createElement("input") as HTMLInputElement;
    this.input.type = "text";
    this.input.className = "cp-code";
    this.input.title = "Game Genie（例 SXIOPO）または AAAA:VV[:CC]（例 0010:42）";

    this.comment = document.createElement("input") as HTMLInputElement;
    this.comment.type = "text";
    this.comment.className = "cp-comment";
    this.comment.title = "任意のラベル";

    const add_btn = document.createElement("button");
    add_btn.textContent = "追加";
    add_btn.addEventListener("click", () => this.add_from_input());
    this.input.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Enter") this.add_from_input();
      // ゲーム側へキーを流さない（入力欄でのタイプなので）。
      ev.stopPropagation();
    });
    this.comment.addEventListener("keydown", (e) => (e as KeyboardEvent).stopPropagation());

    this.toggle_all_btn = document.createElement("button");
    this.toggle_all_btn.addEventListener("click", () => {
      if (this.nes === null) return;
      this.nes.bus.cheats.toggle_all();
      this.refresh();
      this.on_change?.();
    });

    const export_btn = document.createElement("button");
    export_btn.textContent = ".cht を書き出す";
    export_btn.addEventListener("click", () => this.export_cht?.());

    form.append(this.input, this.comment, add_btn, this.toggle_all_btn, export_btn);

    this.message = document.createElement("div");
    this.message.className = "cp-msg";
    this.list_el = document.createElement("div");
    this.list_el.className = "cp-list";

    root.append(form, this.message, this.list_el);
  }

  // `.cht` 書き出しは呼び出し側（ダウンロード手段を持つ側）に委ねる。
  export_cht: (() => void) | null = null;

  get is_open(): boolean {
    return !this.root.hidden;
  }

  attach(nes: Nes): void {
    this.nes = nes;
    if (this.is_open) this.refresh();
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
    if (this.is_open) this.refresh();
  }

  open(): void {
    this.root.hidden = false;
    this.refresh();
  }

  close(): void {
    this.root.hidden = true;
  }

  // 入力欄のコードを 1 件追加する。
  add_from_input(): void {
    if (this.nes === null) {
      this.message.textContent = "先に ROM を読み込んで";
      return;
    }
    const code = this.input.value.trim();
    if (code.length === 0) return;
    try {
      const c = parse_line(code);
      c.comment = this.comment.value.trim();
      this.nes.bus.cheats.add(c);
      this.input.value = "";
      this.comment.value = "";
      this.message.textContent = `追加: ${code}`;
      this.refresh();
      this.on_change?.();
    } catch (e) {
      this.message.textContent = `不正なコード: ${(e as Error).message}`;
    }
  }

  // 一覧を作り直す（件数が少ないので毎回作る）。
  refresh(): void {
    if (this.nes === null) return;
    const cheats = this.nes.bus.cheats;
    this.toggle_all_btn.textContent = cheats.enabled() ? "全体: 有効" : "全体: 無効";
    this.toggle_all_btn.className = cheats.enabled() ? "cp-on" : "cp-off";

    const rows: HTMLElement[] = [];
    const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
    const h4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");
    cheats.list().forEach((c, i) => {
      const row = document.createElement("div");
      row.className = c.enabled ? "cp-row" : "cp-row cp-disabled";

      const box = document.createElement("input") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = c.enabled;
      box.dataset.index = String(i);
      box.addEventListener("change", () => {
        cheats.set_enabled(i, box.checked);
        this.refresh();
        this.on_change?.();
      });

      const text = document.createElement("span");
      text.className = "cp-text";
      const cmp = c.has_compare ? `:${h2(c.compare)}` : "";
      text.textContent = `${c.source.padEnd(9, " ")} $${h4(c.address)} = ${h2(c.value)}${cmp}`;

      const note = document.createElement("span");
      note.className = "cp-note";
      note.textContent = c.comment;

      const del = document.createElement("button");
      del.textContent = "削除";
      del.dataset.del = String(i);
      del.addEventListener("click", () => {
        cheats.remove(i);
        this.refresh();
        this.on_change?.();
      });

      row.append(box, text, note, del);
      rows.push(row);
    });

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cp-note";
      empty.textContent =
        "チート未登録。Game Genie コード（SXIOPO）か AAAA:VV（0010:42）を入れて追加、または .cht をドロップ。";
      rows.push(empty);
    }
    this.list_el.replaceChildren(...rows);
  }
}
