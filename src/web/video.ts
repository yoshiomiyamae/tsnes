// Canvas 描画（PPU の ARGB フレームバッファ → ImageData）。
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../core/ppu.ts";

export class Video {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  // ImageData のバイト列を 32bit で叩くビュー（LE では 0xAABBGGRR）。
  private readonly pixels: Uint32Array;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.image = ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  // frame_buffer は 0xAARRGGBB。canvas は LE で 0xAABBGGRR なので R/B を入れ替える。
  draw(frame_buffer: Uint32Array): void {
    const dst = this.pixels;
    for (let i = 0; i < dst.length; i++) {
      const p = frame_buffer[i]!;
      dst[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0x0000ff00) | ((p >>> 16) & 0xff);
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
