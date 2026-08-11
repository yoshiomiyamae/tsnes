// ヘッドレス実行ツール（移植元 cppnes `sdl/src/main.cpp` + `frontend_util.hpp`）。
//
// cppnes.exe と **同じ CLI・同じ出力バイト列**（BMP / WAV）を出すことで、
// 両者の出力をバイナリ差分して挙動同一性を機械的に検証できる。
//
//   bun run tools/headless.ts --headless --frames 200 --screenshot out.bmp rom.nes
//   bun run tools/headless.ts --headless --frames 700 --wav out.wav rom.nes
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Nes } from "../src/core/nes.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/core/ppu.ts";

// ROM パスの拡張子を ext に置き換えたコンパニオンパス（"sav" / "state1" 等）。
export function companion_path(rom: string, ext: string): string {
  const slash = Math.max(rom.lastIndexOf("/"), rom.lastIndexOf("\\"));
  const dot = rom.lastIndexOf(".");
  if (dot === -1 || dot < slash) {
    return `${rom}.${ext}`;
  }
  return `${rom.slice(0, dot + 1)}${ext}`;
}

// ARGB(0xAARRGGBB) フレームバッファを 24bit BMP（ボトムアップ BGR）で書き出す。
export function encode_bmp(fb: Uint32Array, w: number, h: number): Uint8Array {
  const row_bytes = w * 3;
  const pixel_data = row_bytes * h;
  const buf = new Uint8Array(14 + 40 + pixel_data);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, 14 + 40 + pixel_data, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(10, 14 + 40, true);
  view.setUint32(14, 40, true);
  view.setUint32(18, w, true);
  view.setUint32(22, h, true); // 正 → ボトムアップ
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixel_data, true);
  view.setUint32(38, 2835, true);
  view.setUint32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);
  let p = 54;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const px = fb[y * w + x]!;
      buf[p++] = px & 0xff;
      buf[p++] = (px >> 8) & 0xff;
      buf[p++] = (px >> 16) & 0xff;
    }
  }
  return buf;
}

// mono 16bit PCM WAV を書き出す（既定 44.1kHz）。float サンプルは [-1,1] にクランプ。
export function encode_wav(samples: Float32Array, rate = 44100): Uint8Array {
  const data_bytes = samples.length * 2;
  const buf = new Uint8Array(44 + data_bytes);
  const view = new DataView(buf.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data_bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  ascii(36, "data");
  view.setUint32(40, data_bytes, true);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!;
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    // C++ は float→int16 の切り捨て変換。
    view.setInt16(44 + i * 2, Math.trunc(Math.fround(s * 32767)), true);
  }
  return buf;
}

function usage(): void {
  console.log(
    "usage: headless [--headless] [--frames N] [--screenshot out.bmp] [--wav out.wav] <rom.nes>",
  );
}

function main(argv: string[]): number {
  let rom_path = "";
  let screenshot = "";
  let wav_path = "";
  let frames = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--headless") {
      // 既定でヘッドレス（互換のため受け付ける）。
    } else if (arg === "--frames" && i + 1 < argv.length) {
      frames = parseInt(argv[++i]!, 10);
    } else if (arg === "--screenshot" && i + 1 < argv.length) {
      screenshot = argv[++i]!;
    } else if (arg === "--wav" && i + 1 < argv.length) {
      wav_path = argv[++i]!;
    } else if (arg.length > 0 && arg[0] !== "-") {
      rom_path = arg;
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      return 2;
    }
  }

  if (rom_path === "") {
    usage();
    return 2;
  }
  if (!existsSync(rom_path)) {
    console.error(`failed to read ROM: ${rom_path}`);
    return 1;
  }

  let nes: Nes;
  try {
    nes = Nes.power_on_from_rom(new Uint8Array(readFileSync(rom_path)));
  } catch (e) {
    console.error(`failed to load ROM: ${(e as Error).message}`);
    return 1;
  }

  // コンパニオン: .sav（バッテリー）/ .cht（チート）を読み込む。
  if (nes.has_battery()) {
    const sav_path = companion_path(rom_path, "sav");
    if (existsSync(sav_path)) {
      nes.load_battery_ram(new Uint8Array(readFileSync(sav_path)));
    }
  }
  {
    const cht_path = companion_path(rom_path, "cht");
    if (existsSync(cht_path)) {
      const errs = nes.load_cheats_str(readFileSync(cht_path, "utf8"));
      console.error(`loaded cheats (${errs.length} errors)`);
    }
  }

  const chunks: Float32Array[] = [];
  let audio_len = 0;
  for (let i = 0; i < frames; i++) {
    nes.step_frame();
    if (wav_path !== "") {
      // フレーム毎に排出（APU 出力バッファのトリムで取りこぼさないため）。
      const chunk = nes.bus.apu.drain_output();
      chunks.push(chunk);
      audio_len += chunk.length;
    }
  }
  const audio = new Float32Array(audio_len);
  {
    let at = 0;
    for (const c of chunks) {
      audio.set(c, at);
      at += c.length;
    }
  }
  console.log(`ran ${frames} frames (cycles=${nes.cycles}, frame=${nes.frame})`);

  if (wav_path !== "") {
    writeFileSync(wav_path, encode_wav(audio, 44100));
    console.log(`wrote wav: ${wav_path} (${audio.length} samples)`);
  }

  if (screenshot !== "") {
    writeFileSync(screenshot, encode_bmp(nes.framebuffer(), SCREEN_WIDTH, SCREEN_HEIGHT));
    console.log(`wrote screenshot: ${screenshot}`);
  }

  // バッテリー RAM を書き戻す。
  if (nes.has_battery()) {
    writeFileSync(companion_path(rom_path, "sav"), nes.battery_ram());
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
