// Game Genie / raw poke チート（移植元 cppnes `cheat.hpp` / `cheat.cpp`）。
//
// `.cht` ファイル形式は gones / rsnes / cppnes と互換。読み出し時にアドレスを
// 傍受し、パッチ済みアドレスを CPU が読むとチートバイトを返す。

// デコード済みパッチ 1 件。
export interface Cheat {
  address: number; // u16
  value: number; // u8
  compare: number; // u8
  has_compare: boolean;
  enabled: boolean;
  source: string; // 元コードテキスト
  comment: string; // .cht の任意ラベル
}

function new_cheat(): Cheat {
  return {
    address: 0,
    value: 0,
    compare: 0,
    has_compare: false,
    enabled: false,
    source: "",
    comment: "",
  };
}

export class CheatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheatError";
  }
}

// Game Genie 文字 → 4 ビット nibble。Galoob ハードウェア固定順。
const GENIE_CHARSET = "APZLGITYEOXUKSVN";

// 16 進文字列をパースする（`$` / `0x` 前置は許容）。
function parse_hex(input: string, bits: number): number {
  let s = input.trim();
  if (s.startsWith("$")) {
    s = s.slice(1);
  } else if (s.startsWith("0x") || s.startsWith("0X")) {
    s = s.slice(2);
  }
  if (s.length === 0) throw new CheatError("empty hex value");
  let v = 0;
  for (const c of s) {
    let d: number;
    if (c >= "0" && c <= "9") d = c.charCodeAt(0) - 0x30;
    else if (c >= "a" && c <= "f") d = c.charCodeAt(0) - 0x61 + 10;
    else if (c >= "A" && c <= "F") d = c.charCodeAt(0) - 0x41 + 10;
    else throw new CheatError(`invalid hex digit in ${s}`);
    v = v * 16 + d;
  }
  if (bits < 64 && v >= 2 ** bits) {
    throw new CheatError(`value ${s} exceeds ${bits} bits`);
  }
  return v;
}

// `AAAA:VV` / `AAAA:VV:CC` 形式をパースする。
function parse_raw(line: string): Cheat {
  const parts = line.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new CheatError(`raw cheat: want AAAA:VV[:CC], got ${line}`);
  }
  const c = new_cheat();
  c.address = parse_hex(parts[0]!, 16) & 0xffff;
  c.value = parse_hex(parts[1]!, 8) & 0xff;
  c.source = line;
  if (parts.length === 3) {
    c.compare = parse_hex(parts[2]!, 8) & 0xff;
    c.has_compare = true;
  }
  return c;
}

// `#` / `;` でコメントを分離する。
function split_comment(line: string): [string, string] {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "#" || ch === ";") {
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }
  }
  return [line, ""];
}

// 6/8 文字の Game Genie コードを Cheat へデコードする。
export function decode_game_genie(code_in: string): Cheat {
  const code = code_in.toUpperCase();
  if (code.length !== 6 && code.length !== 8) {
    throw new CheatError(`game genie: code length must be 6 or 8, got ${code.length}`);
  }
  const n = new Uint8Array(8);
  for (let i = 0; i < code.length; i++) {
    const idx = GENIE_CHARSET.indexOf(code[i]!);
    if (idx < 0) throw new CheatError(`game genie: invalid character in ${code}`);
    n[i] = idx;
  }

  const addr =
    (0x8000 |
      ((n[3]! & 7) << 12) |
      ((n[5]! & 7) << 8) |
      ((n[4]! & 8) << 8) |
      ((n[2]! & 7) << 4) |
      ((n[1]! & 8) << 4) |
      (n[4]! & 7) |
      (n[3]! & 8)) &
    0xffff;

  const c = new_cheat();
  c.address = addr;
  c.source = code;
  if (code.length === 6) {
    c.value = (((n[1]! & 7) << 4) | ((n[0]! & 8) << 4) | (n[0]! & 7) | (n[5]! & 8)) & 0xff;
  } else {
    c.value = (((n[1]! & 7) << 4) | ((n[0]! & 8) << 4) | (n[0]! & 7) | (n[7]! & 8)) & 0xff;
    c.compare = (((n[7]! & 7) << 4) | ((n[6]! & 8) << 4) | (n[6]! & 7) | (n[5]! & 8)) & 0xff;
    c.has_compare = true;
  }
  return c;
}

// 1 行をパースする（`:` 含めば raw `AAAA:VV[:CC]`、それ以外は Game Genie）。
export function parse_line(line: string): Cheat {
  if (line.includes(":")) {
    return parse_raw(line);
  }
  return decode_game_genie(line);
}

// `.cht` テキストをパースする。空行・コメントは無視、不正行はエラー集約。
export function load_str(text: string): { cheats: Cheat[]; errors: string[] } {
  const cheats: Cheat[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i]!;
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    const line_no = i + 1;

    const [code_part, comment] = split_comment(raw);
    const code = code_part.trim();
    if (code.length === 0) continue;
    try {
      const c = parse_line(code);
      c.comment = comment;
      cheats.push(c);
    } catch (e) {
      errors.push(`line ${line_no}: ${(e as Error).message}`);
    }
  }
  return { cheats, errors };
}

// チート一覧とグローバル ON/OFF を管理する。
export class CheatManager {
  private cheats_: Cheat[] = [];
  private enabled_ = true;

  add(c: Cheat): void {
    c.enabled = true;
    this.cheats_.push(c);
  }

  // 登録済みチートを全消去する（グローバル有効/無効状態は保持）。
  clear(): void {
    this.cheats_.length = 0;
  }

  // `.cht` テキストを読み込んで追加する。戻りはパースエラー一覧。
  load_str(text: string): string[] {
    const { cheats, errors } = load_str(text);
    for (const c of cheats) this.add(c);
    return errors;
  }

  count(): number {
    return this.cheats_.length;
  }
  is_empty(): boolean {
    return this.cheats_.length === 0;
  }
  enabled(): boolean {
    return this.enabled_;
  }
  toggle_all(): boolean {
    this.enabled_ = !this.enabled_;
    return this.enabled_;
  }
  list(): readonly Cheat[] {
    return this.cheats_;
  }

  // ---- 以下は tsnes 追加分（cppnes は一括 ON/OFF と再読み込みしか持たない）。
  // ブラウザ上でチートを個別に編集するために足した。----

  // index 番目のチートの有効/無効を切り替える（範囲外は no-op）。
  set_enabled(index: number, on: boolean): void {
    const c = this.cheats_[index];
    if (c !== undefined) c.enabled = on;
  }

  // index 番目のチートを削除する（範囲外は no-op）。
  remove(index: number): void {
    if (index >= 0 && index < this.cheats_.length) {
      this.cheats_.splice(index, 1);
    }
  }

  // `.cht` テキストとして書き出す（gones / rsnes / cppnes が読める形式）。
  // 元コードテキスト（source）をそのまま出すので Game Genie コードも往復する。
  to_cht_text(): string {
    return this.cheats_
      .map((c) => (c.comment.length > 0 ? `${c.source} # ${c.comment}` : c.source))
      .join("\n")
      .concat("\n");
  }

  // addr に一致する有効チートがあればパッチ後バイトを、無ければ current を返す。
  apply(addr: number, current: number): number {
    if (!this.enabled_) return current;
    for (const c of this.cheats_) {
      if (!c.enabled || c.address !== addr) continue;
      if (c.has_compare && c.compare !== current) continue;
      return c.value;
    }
    return current;
  }
}
