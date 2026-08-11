// ヘックスダンプ表示のレイアウト/フォーマット純粋ロジック（移植元 cppnes `sdl/src/hexdump.hpp`）。
//
// RamViewer（ramview.ts）が 16 バイト/行のダンプを描画する際のカラム位置と
// 16 進整形をここに集約する。1 行のレイアウト（セル＝1 文字）:
//
//   $XXXX: b0 b1 .. b7  b8 .. bF  |................|
//   ^col0  ^col7        ^col32     ^ascii(col56)
//
// 8 バイト目の前に区切りの空白を 1 つ挟むため、byte 8 以降のカラムは +1 される。

const HEX = "0123456789ABCDEF";

// 16 進 1 桁（大文字）。
export function hex_digit(v: number): string {
  return HEX[v & 0xf]!;
}

// 1 バイトを 2 桁 16 進文字列に。
export function hex_byte(v: number): string {
  return hex_digit(v >> 4) + hex_digit(v);
}

// アドレスラベル "$XXXX:"（末尾コロンまで、6 文字）。
export function format_addr(addr: number): string {
  return `$${hex_digit(addr >> 12)}${hex_digit(addr >> 8)}${hex_digit(addr >> 4)}${hex_digit(addr)}:`;
}

// 行内での byte i (0..15) の 16 進が始まる文字カラム。
// 先頭ラベル "$XXXX: " が 7 セル、各バイトは "XX " で 3 セル、8 バイト目以降は区切り +1。
export function hex_byte_col(i: number): number {
  return 7 + i * 3 + (i >= 8 ? 1 : 0);
}

// ASCII 列が始まる文字カラム（16 バイト分の後、区切りを挟んだ先）。
export function hex_ascii_col(): number {
  return hex_byte_col(15) + 3;
}

// 1 行の総文字数（ASCII 16 文字 + 末尾の区切り 1）。
export function hex_line_cols(): number {
  return hex_ascii_col() + 16 + 1;
}

// ASCII 列に出す文字。印字可能（0x20-0x7E）はそのまま、その他は '.'。
export function printable(b: number): string {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}

// ヘックスダンプ 1 バイトの表示分類（色の出し分け）。
// 優先順位は Cheat（作用中）> CheatSet（登録のみ）> Changed > ゼロ/値。
export enum ByteClass {
  Zero, // 実体値が 0（暗色）
  Value, // 非ゼロの実体値（通常色）
  Changed, // 前回描画から実体値が変化（赤）
  CheatSet, // チート登録ありだが実体値と一致＝すり替えても結果不変（暗シアン）
  Cheat, // チートが実体と異なる値をすり替え中（明シアン）
}

// 表示分類を決める。cheat_addr=この番地にチート登録あり、cheat_active=実際に
// 読み出し値がすり替わっている（実体≠適用後）。作用中が最優先、次に登録のみ、
// 次に変化、最後にゼロ/非ゼロ。
export function classify_byte(
  actual: number,
  changed: boolean,
  cheat_addr: boolean,
  cheat_active: boolean,
): ByteClass {
  if (cheat_active) return ByteClass.Cheat;
  if (cheat_addr) return ByteClass.CheatSet;
  if (changed) return ByteClass.Changed;
  return actual === 0 ? ByteClass.Zero : ByteClass.Value;
}

// 6502 ステータスレジスタ P を "NV-BDIZC" 形式の 8 文字に整形する。
// セットされたビットは大文字、クリアは小文字、bit5（未使用）は常に '-'。
export function format_p_flags(p: number): string {
  const names = "NVUBDIZC"; // bit 7..0（bit5 は表示上 '-'）
  let s = "";
  for (let i = 0; i < 8; i++) {
    const bit = 7 - i;
    if (bit === 5) {
      s += "-";
    } else {
      s += p & (1 << bit) ? names[i]! : names[i]!.toLowerCase();
    }
  }
  return s;
}
