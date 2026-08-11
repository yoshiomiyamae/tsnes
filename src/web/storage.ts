// バッテリー RAM（.sav）とセーブステートの永続化。
//
// 形式は cppnes / rsnes / gones と互換なので、ダウンロードしたファイルを
// そのままデスクトップ版で読める（.sav は生 PRG RAM、ステートはマジック "RSST"）。

const SAV_PREFIX = "tsnes:sav:";
const STATE_PREFIX = "tsnes:state:";
const CHT_PREFIX = "tsnes:cht:";

function to_base64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function from_base64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function save_battery(rom_name: string, data: Uint8Array): void {
  try {
    localStorage.setItem(SAV_PREFIX + rom_name, to_base64(data));
  } catch {
    // 容量超過等は無視（ゲーム進行は止めない）。
  }
}

export function load_battery(rom_name: string): Uint8Array | null {
  const s = localStorage.getItem(SAV_PREFIX + rom_name);
  return s === null ? null : from_base64(s);
}

export function save_state_slot(rom_name: string, slot: number, data: Uint8Array): boolean {
  try {
    localStorage.setItem(`${STATE_PREFIX}${rom_name}:${slot}`, to_base64(data));
    return true;
  } catch {
    return false;
  }
}

export function load_state_slot(rom_name: string, slot: number): Uint8Array | null {
  const s = localStorage.getItem(`${STATE_PREFIX}${rom_name}:${slot}`);
  return s === null ? null : from_base64(s);
}

// チート（.cht テキスト）を ROM 名で保存 / 復元する。
export function save_cheats(rom_name: string, text: string): void {
  try {
    if (text.trim().length === 0) localStorage.removeItem(CHT_PREFIX + rom_name);
    else localStorage.setItem(CHT_PREFIX + rom_name, text);
  } catch {
    // 容量超過等は無視。
  }
}

export function load_cheats(rom_name: string): string | null {
  return localStorage.getItem(CHT_PREFIX + rom_name);
}

// バイト列をファイルとしてダウンロードさせる（cppnes と交換するため）。
export function download(filename: string, data: Uint8Array): void {
  // Blob は内容をコピーするので view をそのまま渡せるが、`Uint8Array<ArrayBufferLike>`
  // は BlobPart（`ArrayBufferView<ArrayBuffer>`）に代入できないため ArrayBuffer を明示する。
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
