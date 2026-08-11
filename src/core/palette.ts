// NES パレット管理（移植元 cppnes `palette.hpp` / `palette.cpp`）。

// NES マスターパレット（64 色、RGB）。
// prettier-ignore
const MASTER_PALETTE: readonly (readonly [number, number, number])[] = [
  [0x80, 0x80, 0x80], [0x00, 0x3d, 0xa6], [0x00, 0x12, 0xb0], [0x44, 0x00, 0x96],
  [0xa1, 0x00, 0x5e], [0xc7, 0x00, 0x28], [0xba, 0x06, 0x00], [0x8c, 0x17, 0x00],
  [0x5c, 0x2f, 0x00], [0x10, 0x45, 0x00], [0x05, 0x4a, 0x00], [0x00, 0x47, 0x2e],
  [0x00, 0x41, 0x66], [0x00, 0x00, 0x00], [0x05, 0x05, 0x05], [0x05, 0x05, 0x05],
  [0xc7, 0xc7, 0xc7], [0x00, 0x77, 0xff], [0x21, 0x55, 0xff], [0x82, 0x37, 0xfa],
  [0xeb, 0x2f, 0xb5], [0xff, 0x29, 0x50], [0xff, 0x22, 0x00], [0xd6, 0x32, 0x00],
  [0xc4, 0x62, 0x00], [0x35, 0x80, 0x00], [0x05, 0x8f, 0x00], [0x00, 0x8a, 0x55],
  [0x00, 0x99, 0xcc], [0x21, 0x21, 0x21], [0x09, 0x09, 0x09], [0x09, 0x09, 0x09],
  [0xff, 0xff, 0xff], [0x0f, 0xd7, 0xff], [0x69, 0xa2, 0xff], [0xd4, 0x80, 0xff],
  [0xff, 0x45, 0xf3], [0xff, 0x61, 0x8b], [0xff, 0x88, 0x33], [0xff, 0x9c, 0x12],
  [0xfa, 0xbc, 0x20], [0x9f, 0xe3, 0x0e], [0x2b, 0xf0, 0x35], [0x0c, 0xf0, 0xa4],
  [0x05, 0xfb, 0xff], [0x5e, 0x5e, 0x5e], [0x0d, 0x0d, 0x0d], [0x0d, 0x0d, 0x0d],
  [0xff, 0xff, 0xff], [0xa6, 0xfc, 0xff], [0xb3, 0xec, 0xff], [0xda, 0xab, 0xeb],
  [0xff, 0xa8, 0xf9], [0xff, 0xab, 0xb3], [0xff, 0xd2, 0xb0], [0xff, 0xef, 0xa6],
  [0xff, 0xf7, 0x9c], [0xd7, 0xff, 0xb3], [0xc6, 0xff, 0xde], [0xc4, 0xff, 0xf6],
  [0xc4, 0xf0, 0xff], [0xcc, 0xcc, 0xcc], [0x3c, 0x3c, 0x3c], [0x3c, 0x3c, 0x3c],
];

// パレット RAM・エンファシス・色キャッシュを管理する。
export class PaletteManager {
  // パレット RAM（32 バイト）。$10/$14/$18/$1C は $00/$04/$08/$0C へミラー。
  readonly palette_ram = new Uint8Array(32);
  // エンファシスビット（PPUMASK bit5-7）。
  emphasis = 0;

  // (palette<<2 | colorIndex) → 最終 ARGB。
  private readonly bg_color_cache = new Uint32Array(16);
  private readonly spr_color_cache = new Uint32Array(16);

  constructor() {
    // 移植元と同じパワーオン初期値（デバッグ用の見やすい色）。
    this.palette_ram.fill(0x30);
    this.palette_ram[0] = 0x0f; // バックドロップ（黒）
    this.palette_ram[1] = 0x30; // 白
    this.palette_ram[2] = 0x10; // 明灰
    this.palette_ram[3] = 0x00; // 暗灰
    this.rebuild_color_cache();
  }

  read_palette(addr: number): number {
    return this.palette_ram[PaletteManager.mirror_palette_addr(addr)]!;
  }

  write_palette(addr: number, value: number): void {
    this.palette_ram[PaletteManager.mirror_palette_addr(addr)] = value & 0x3f;
    this.rebuild_color_cache();
  }

  private static mirror_palette_addr(addr: number): number {
    addr = addr & 0x1f;
    switch (addr) {
      case 0x10: return 0x00;
      case 0x14: return 0x04;
      case 0x18: return 0x08;
      case 0x1c: return 0x0c;
      default: return addr;
    }
  }

  // パレット RAM/エンファシスから派生色キャッシュを再構築する。
  rebuild_color_cache(): void {
    for (let pal = 0; pal < 4; pal++) {
      for (let ci = 0; ci < 4; ci++) {
        const i = pal * 4 + ci;
        if (ci === 0) {
          // BG 色 0 = ユニバーサルバックドロップ（$3F00）
          this.bg_color_cache[i] = this.argb_color(this.read_palette(0));
          // スプライト色 0 = 透明
          this.spr_color_cache[i] = 0x00000000;
          continue;
        }
        this.bg_color_cache[i] = this.argb_color(this.read_palette(pal * 4 + ci));
        this.spr_color_cache[i] = this.argb_color(this.read_palette(0x10 + pal * 4 + ci));
      }
    }
  }

  // 背景ピクセルの ARGB（palette/color_index は 0-3）。
  background_color(palette: number, color_index: number): number {
    if (palette > 3 || color_index > 3) {
      return 0xff000000;
    }
    return this.bg_color_cache[palette * 4 + color_index]!;
  }

  // スプライトピクセルの ARGB（色 0 は透明）。
  sprite_color(palette: number, color_index: number): number {
    if (palette > 3 || color_index > 3) {
      return 0x00000000;
    }
    return this.spr_color_cache[palette * 4 + color_index]!;
  }

  private argb_color(palette_index: number): number {
    const idx = palette_index & 0x3f;
    const em = (this.emphasis >> 5) & 0x07; // 0-7
    const entry = MASTER_PALETTE[idx]!;
    let r = entry[0];
    let g = entry[1];
    let b = entry[2];
    // gones 互換: ビットが 0 のとき該当チャンネルを 0.75 倍。
    if ((em & 0x1) === 0) r = Math.trunc(r * 0.75);
    if ((em & 0x2) === 0) g = Math.trunc(g * 0.75);
    if ((em & 0x4) === 0) b = Math.trunc(b * 0.75);
    return ((0xff000000 | (r << 16) | (g << 8) | b) >>> 0);
  }

  // エンファシスを設定し、変化があれば色キャッシュを再構築する。
  set_emphasis(e: number): void {
    e = e & 0xe0;
    if (e === this.emphasis) {
      return;
    }
    this.emphasis = e;
    this.rebuild_color_cache();
  }
}
