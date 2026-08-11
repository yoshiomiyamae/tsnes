// ブラウザ無しで src/web の DOM ロジックを検証するための最小 DOM スタブ。
//
// RamViewer / CheatPanel が実際に使う API だけを実装する（依存を増やさないため
// jsdom 等は使わない）。install_dom() で globalThis.document を差し替える。

export class StubElement {
  tagName: string;
  className = "";
  hidden = false;
  type = "";
  value = "";
  checked = false;
  title = "";
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly children: (StubElement | { text: string })[] = [];
  private text_ = "";
  private readonly listeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text_;
  }
  set textContent(v: string) {
    this.text_ = v;
    // textContent への代入は子ノードを置き換える（DOM と同じ挙動）。
    this.children.length = 0;
  }

  append(...nodes: (StubElement | { text: string })[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: (StubElement | { text: string })[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  // テスト用: 登録済みリスナを発火する。
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn({ target: this, preventDefault: () => {}, ...event });
    }
  }

  readonly classList = {
    add: (c: string) => {
      if (!this.className.split(" ").includes(c)) {
        this.className = this.className.length === 0 ? c : `${this.className} ${c}`;
      }
    },
    remove: (c: string) => {
      this.className = this.className
        .split(" ")
        .filter((x) => x !== c && x.length > 0)
        .join(" ");
    },
  };

  // 自分と子孫を平坦に集める。
  walk(out: StubElement[] = []): StubElement[] {
    out.push(this);
    for (const c of this.children) {
      if (c instanceof StubElement) c.walk(out);
    }
    return out;
  }

  // tagName で子孫を絞る。
  find_all(tag: string): StubElement[] {
    return this.walk().filter((e) => e.tagName === tag);
  }
}

let saved_document: unknown;

export function install_dom(): void {
  saved_document = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new StubElement(tag),
    createTextNode: (text: string) => ({ text }),
  };
}

export function uninstall_dom(): void {
  (globalThis as { document?: unknown }).document = saved_document;
}

export function make_root(): StubElement {
  return new StubElement("div");
}
