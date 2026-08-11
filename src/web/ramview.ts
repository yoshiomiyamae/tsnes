// RAM / レジスタビューア（移植元 cppnes `sdl/src/ramview.cpp` / `ramview.hpp`）。
//
// cppnes は SDL の別ウィンドウに 8x8 ビットマップフォントで描いていたが、
// ブラウザでは DOM で組む。レイアウト（16 バイト/行・2 パネル＝2KB/画面）、
// 領域切替、色分けの意味論は原典と同じで、**値の書き換え**を追加している。
//
//   ・上部に CPU/PPU/APU レジスタ、下部にヘックスダンプ
//   ・`<` `>` で領域切替: WRAM $0000-$07FF / PRG-RAM $6000-（2KB ごとページ送り）
//   ・色: 変化=赤、ゼロ=暗、非ゼロ=通常、チート作用中=明シアン、登録のみ=暗シアン
//   ・16 進セルをクリック → 16 進 2 桁を打ち込んで書き換え（Esc で取り消し）
//
// 読み出しは副作用のない経路（bus.ram / cartridge.save_ram / 公開フィールド）から
// 行う。書き込みも同じ配列へ直接行うので、マッパーの書き込み保護を経由しない。
import type { Nes } from "../core/nes.ts";
import {
  ByteClass,
  classify_byte,
  format_addr,
  format_p_flags,
  hex_byte,
  printable,
} from "./hexdump.ts";

const PANEL_ROWS = 64; // 1 パネル 64 行（= 1KB）
const TOTAL_ROWS = 128; // 2KB / 16 バイト
const BYTES_PER_ROW = 16;
const WINDOW_BYTES = TOTAL_ROWS * BYTES_PER_ROW; // 2048

// ByteClass → CSS クラス（配色は index.html 側の CSS に持たせる）。
const CLASS_NAME: Record<ByteClass, string> = {
  [ByteClass.Zero]: "b-zero",
  [ByteClass.Value]: "b-val",
  [ByteClass.Changed]: "b-chg",
  [ByteClass.CheatSet]: "b-cheatset",
  [ByteClass.Cheat]: "b-cheat",
};

interface Cell {
  hex: HTMLElement;
  ascii: HTMLElement;
}

export class RamViewer {
  private readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly regs: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly cells: Cell[] = [];
  private readonly rows: HTMLElement[] = [];
  private readonly addr_labels: HTMLElement[] = [];
  private built = false;

  // 現在の表示領域インデックス（0=WRAM, 1..=PRG-RAM ページ）。render で範囲内に丸める。
  private view_ = 0;
  // 変化バイト強調用の前回スナップショット（表示中の 2KB 分）。
  private readonly prev_ = new Uint8Array(WINDOW_BYTES);
  private have_prev_ = false;
  // 表示中ウィンドウの実体バッファと先頭アドレス（書き換えに使う）。
  private cur_buf_: Uint8Array | null = null;
  private cur_offset_ = 0;
  private base_addr_ = 0;

  // 編集状態: 選択中のオフセット（-1=非編集）と打ち込み済みの 16 進桁。
  private edit_at_ = -1;
  private edit_digits_ = "";

  constructor(root: HTMLElement) {
    this.root = root;
    this.head = document.createElement("div");
    this.head.className = "rv-head";
    this.regs = document.createElement("div");
    this.regs.className = "rv-regs";
    this.grid = document.createElement("div");
    this.grid.className = "rv-grid";
    root.append(this.head, this.regs, this.grid);
    root.hidden = true;
  }

  get is_open(): boolean {
    return !this.root.hidden;
  }

  // 編集中はゲーム入力を止める（main.ts が参照する）。
  get editing(): boolean {
    return this.edit_at_ >= 0;
  }

  toggle(): void {
    if (this.is_open) this.close();
    else this.open();
  }

  open(): void {
    this.build();
    this.root.hidden = false;
    this.have_prev_ = false; // 開いた直後は全バイトを「未変化」扱いに。
  }

  close(): void {
    this.root.hidden = true;
    this.cancel_edit();
  }

  // 表示領域を前後に切り替える（dir<0 で前、dir>0 で次）。
  cycle_view(dir: number): void {
    this.view_ += dir; // 範囲丸めは render（領域数が判る場所）で行う。
    this.have_prev_ = false; // 領域が変わるので変化強調をリセット。
    this.cancel_edit();
  }

  // ---- 編集 ----

  private begin_edit(offset: number): void {
    if (this.edit_at_ === offset) return;
    this.cancel_edit();
    this.edit_at_ = offset;
    this.edit_digits_ = "";
    this.cells[offset]?.hex.classList.add("b-edit");
  }

  cancel_edit(): void {
    if (this.edit_at_ >= 0) {
      this.cells[this.edit_at_]?.hex.classList.remove("b-edit");
    }
    this.edit_at_ = -1;
    this.edit_digits_ = "";
  }

  // 編集中のキー入力を処理する。処理したら true（呼び出し側でイベントを止める）。
  handle_key(key: string): boolean {
    if (this.edit_at_ < 0) return false;
    if (key === "Escape") {
      this.cancel_edit();
      return true;
    }
    if (key === "ArrowRight" || key === "ArrowLeft" || key === "ArrowDown" || key === "ArrowUp") {
      const delta = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? 16 : -16;
      const next = this.edit_at_ + delta;
      if (next >= 0 && next < WINDOW_BYTES) this.begin_edit(next);
      return true;
    }
    if (!/^[0-9a-fA-F]$/.test(key)) return false;
    this.edit_digits_ += key.toUpperCase();
    if (this.edit_digits_.length === 2) {
      this.commit(parseInt(this.edit_digits_, 16));
    }
    return true;
  }

  private commit(value: number): void {
    const at = this.edit_at_;
    const buf = this.cur_buf_;
    if (at >= 0 && buf !== null) {
      const i = this.cur_offset_ + at;
      if (i < buf.length) buf[i] = value & 0xff;
    }
    // 次のバイトへ進んで連続入力できるようにする。
    const next = at + 1;
    this.cancel_edit();
    if (next < WINDOW_BYTES) this.begin_edit(next);
  }

  // ---- 構築 / 描画 ----

  private build(): void {
    if (this.built) return;
    this.built = true;
    // 2 パネル（左 64 行 / 右 64 行）。
    for (let panel = 0; panel < 2; panel++) {
      const col = document.createElement("div");
      col.className = "rv-panel";
      const ruler = document.createElement("div");
      ruler.className = "rv-row rv-ruler";
      // 本文行と同じ区切り（8 バイト目の前だけ広い）でカラム見出しを作る。
      let ruler_text = " ".repeat(format_addr(0).length);
      for (let j = 0; j < BYTES_PER_ROW; j++) {
        ruler_text += (j === 8 ? "  " : " ") + hex_byte(j);
      }
      ruler.textContent = ruler_text;
      col.append(ruler);

      for (let local = 0; local < PANEL_ROWS; local++) {
        const row = document.createElement("div");
        row.className = "rv-row";
        const addr = document.createElement("span");
        addr.className = "b-addr";
        row.append(addr);
        const hex_spans: HTMLElement[] = [];
        for (let j = 0; j < BYTES_PER_ROW; j++) {
          row.append(document.createTextNode(j === 8 ? "  " : " "));
          const cell = document.createElement("span");
          cell.className = "b-val";
          cell.dataset.off = String((panel * PANEL_ROWS + local) * BYTES_PER_ROW + j);
          hex_spans.push(cell);
          row.append(cell);
        }
        row.append(document.createTextNode("  "));
        const ascii_spans: HTMLElement[] = [];
        for (let j = 0; j < BYTES_PER_ROW; j++) {
          const a = document.createElement("span");
          a.className = "b-val";
          ascii_spans.push(a);
          row.append(a);
        }
        // アドレスラベルは render で入れる。
        this.addr_labels[panel * PANEL_ROWS + local] = addr;
        for (let j = 0; j < BYTES_PER_ROW; j++) {
          const idx = (panel * PANEL_ROWS + local) * BYTES_PER_ROW + j;
          this.cells[idx] = { hex: hex_spans[j]!, ascii: ascii_spans[j]! };
        }
        this.rows[panel * PANEL_ROWS + local] = row;
        col.append(row);
      }
      this.grid.append(col);
    }

    // 16 進セルのクリックで編集開始。
    this.grid.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      const off = t.dataset?.off;
      if (off !== undefined) {
        e.preventDefault();
        this.begin_edit(Number(off));
      }
    });
  }

  // 現在の状態を 1 回分描画する（開いているときのみ）。
  render(nes: Nes): void {
    if (!this.is_open) return;

    // 表示領域を決める。0=WRAM、1.. =PRG-RAM の 2KB ページ。
    const sram = nes.bus.cartridge !== null ? nes.bus.cartridge.save_ram() : new Uint8Array(0);
    const prg_pages = Math.floor((sram.length + 0x7ff) / 0x800);
    const total_views = 1 + prg_pages;
    this.view_ = ((this.view_ % total_views) + total_views) % total_views; // 巡回。

    let buf: Uint8Array;
    let offset: number;
    let label: string;
    if (this.view_ === 0) {
      buf = nes.bus.ram;
      offset = 0;
      this.base_addr_ = 0x0000;
      label = "WRAM $0000-$07FF";
    } else {
      buf = sram;
      offset = (this.view_ - 1) * 0x800;
      this.base_addr_ = 0x6000 + offset;
      label = `PRG-RAM $${(this.base_addr_ & 0xffff).toString(16).toUpperCase().padStart(4, "0")}-$${((this.base_addr_ + 0x7ff) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
    }
    this.cur_buf_ = buf;
    this.cur_offset_ = offset;

    this.head.textContent =
      `[${this.view_ + 1}/${total_views}] ${label}   < > 領域切替   ` +
      `暗=00 赤=変化 シアン=チート作用中 深緑=チート登録   16進セルをクリックで書き換え`;

    this.draw_registers(nes);

    // 表示中ウィンドウに入る「有効チート登録番地」を集める。
    // チート機能が無効（toggle_all で OFF）のときは何もマークしない。
    const is_cheat = new Uint8Array(WINDOW_BYTES);
    if (nes.bus.cheats.enabled()) {
      for (const c of nes.bus.cheats.list()) {
        if (!c.enabled) continue;
        const rel = c.address - this.base_addr_;
        if (rel >= 0 && rel < WINDOW_BYTES) is_cheat[rel] = 1;
      }
    }

    for (let row = 0; row < TOTAL_ROWS; row++) {
      const addr = (this.base_addr_ + row * BYTES_PER_ROW) & 0xffff;
      const label_el = this.addr_labels[row];
      const addr_text = format_addr(addr);
      if (label_el !== undefined && label_el.textContent !== addr_text) {
        label_el.textContent = addr_text;
      }
      for (let j = 0; j < BYTES_PER_ROW; j++) {
        const a = row * BYTES_PER_ROW + j;
        const i = offset + a;
        const actual = i < buf.length ? buf[i]! : 0;
        // チート登録番地なら、すり替え後の値を引いて作用中かどうか判定する。
        let shown = actual;
        let cheat_active = false;
        const cheat_addr = is_cheat[a] === 1;
        if (cheat_addr) {
          const patched = nes.bus.cheats.apply((addr + j) & 0xffff, actual);
          if (patched !== actual) {
            shown = patched;
            cheat_active = true;
          }
        }
        const changed = this.have_prev_ && this.prev_[a] !== actual; // 変化は実体値で判定。
        const bc = classify_byte(actual, changed, cheat_addr, cheat_active);
        const cell = this.cells[a]!;
        const hex_text = a === this.edit_at_ ? this.edit_digits_.padEnd(2, "_") : hex_byte(shown);
        if (cell.hex.textContent !== hex_text) cell.hex.textContent = hex_text;
        const cls = CLASS_NAME[bc];
        const want = a === this.edit_at_ ? `${cls} b-edit` : cls;
        if (cell.hex.className !== want) cell.hex.className = want;
        const ch = printable(shown);
        if (cell.ascii.textContent !== ch) cell.ascii.textContent = ch;
        if (cell.ascii.className !== cls) cell.ascii.className = cls;
        this.prev_[a] = actual;
      }
    }
    this.have_prev_ = true;
  }

  private draw_registers(nes: Nes): void {
    const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
    const h4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");
    const cpu = nes.cpu;
    const ppu = nes.bus.ppu;
    const apu = nes.bus.apu;
    const on = (e: boolean) => (e ? "E" : ".");
    this.regs.textContent =
      `CPU  A=${h2(cpu.a)} X=${h2(cpu.x)} Y=${h2(cpu.y)} SP=${h2(cpu.sp)} PC=${h4(cpu.pc)} ` +
      `P=${h2(cpu.p)}[${format_p_flags(cpu.p)}]  cyc=${cpu.cycles}\n` +
      `PPU  CTRL=${h2(ppu.ppuctrl)} MASK=${h2(ppu.ppumask)} STAT=${h2(ppu.ppustatus)} ` +
      `OAMA=${h2(ppu.oamaddr)}  sl=${ppu.scanline} cyc=${ppu.cycle} frame=${ppu.frame}\n` +
      `APU  P1[${on(apu.pulse1.enabled)}]L${h2(apu.pulse1.length.value)} ` +
      `P2[${on(apu.pulse2.enabled)}]L${h2(apu.pulse2.length.value)} ` +
      `TRI[${on(apu.triangle.enabled)}]L${h2(apu.triangle.length.value)} ` +
      `NOI[${on(apu.noise.enabled)}]L${h2(apu.noise.length.value)} ` +
      `DMC[${on(apu.dmc.enabled)}]${apu.dmc.current_length}b`;
  }
}
