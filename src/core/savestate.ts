// セーブステートのシリアライズヘルパー（移植元 cppnes `savestate.hpp`）。
//
// マジック "RSST"(=0x54535352) + バージョンで版管理する。cppnes / rsnes と
// **バイト互換**なので `.state` を相互ロードできる。
// C++ の `std::expected<T, StateError>` は TS では例外（StateError）に写す。

export const STATE_MAGIC = 0x54535352; // "RSST"（LE）
export const STATE_VERSION = 1;

export enum StateErrorKind {
  UnexpectedEof,
  BadMagic,
  VersionMismatch,
}

const STATE_ERROR_MESSAGE: Record<StateErrorKind, string> = {
  [StateErrorKind.UnexpectedEof]: "unexpected end of save state",
  [StateErrorKind.BadMagic]: "not a tsnes save state (bad magic)",
  [StateErrorKind.VersionMismatch]: "save state version mismatch",
};

export class StateError extends Error {
  readonly kind: StateErrorKind;
  constructor(kind: StateErrorKind) {
    super(STATE_ERROR_MESSAGE[kind]);
    this.name = "StateError";
    this.kind = kind;
  }
}

// LE バイト列へ書き出すライタ。
export class StateWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private reserve(n: number): number {
    const need = this.len + n;
    if (need > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.len;
    this.len = need;
    return at;
  }

  u8(v: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, v & 0xff);
  }
  u16(v: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, v & 0xffff, true);
  }
  u32(v: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, v >>> 0, true);
  }
  // JS の数値は 2^53 まで正確。NES のサイクル/フレーム数には十分。
  u64(v: number): void {
    const at = this.reserve(8);
    this.view.setBigUint64(at, BigInt(Math.trunc(v)), true);
  }
  i32(v: number): void {
    const at = this.reserve(4);
    this.view.setInt32(at, v | 0, true);
  }
  i64(v: number): void {
    const at = this.reserve(8);
    this.view.setBigInt64(at, BigInt(Math.trunc(v)), true);
  }
  f32(v: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, v, true);
  }
  f64(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
  }
  boolean(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  // 固定長バイト列（長さプレフィックスなし）。
  bytes(b: Uint8Array): void {
    const at = this.reserve(b.length);
    this.buf.set(b, at);
  }

  // 可変長バイト列（u32 長プレフィックス付き）。
  vec(b: Uint8Array): void {
    this.u32(b.length);
    this.bytes(b);
  }

  into_bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// LE バイト列から読み戻すリーダ。
export class StateReader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private take(n: number): number {
    if (this.pos + n > this.buf.length) {
      throw new StateError(StateErrorKind.UnexpectedEof);
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  u64(): number {
    return Number(this.view.getBigUint64(this.take(8), true));
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  i64(): number {
    return Number(this.view.getBigInt64(this.take(8), true));
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }
  boolean(): boolean {
    return this.u8() !== 0;
  }

  // 固定長バイト列を dst へ読み込む。
  read_into(dst: Uint8Array): void {
    const at = this.take(dst.length);
    dst.set(this.buf.subarray(at, at + dst.length));
  }

  // u32 長プレフィックス付き可変長バイト列。
  vec(): Uint8Array {
    const n = this.u32();
    const at = this.take(n);
    return this.buf.slice(at, at + n);
  }

  position(): number {
    return this.pos;
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
}
