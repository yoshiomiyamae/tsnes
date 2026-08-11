// ブラウザフロントエンド エントリポイント（移植元 cppnes `sdl/src/gui.cpp` 相当）。
//
// 操作（既定）:
//   Z=A X=B A=Select S=Start 矢印=十字 / Tab=ターボ / Ctrl+R=リセット
//   F1-F10=ステート保存 Ctrl+F1-F10=ロード / M=音声ミュート / 8=スプライト制限解除
import { Nes } from "../core/nes.ts";
import { Audio, APU_SAMPLE_RATE } from "./audio.ts";
import { CheatPanel } from "./cheatpanel.ts";
import { Input } from "./input.ts";
import { RamViewer } from "./ramview.ts";
import {
  download,
  load_battery,
  load_cheats,
  load_state_slot,
  save_battery,
  save_cheats,
  save_state_slot,
} from "./storage.ts";
import { Video } from "./video.ts";

const TARGET_FPS = 60.0988; // NTSC
// 音声バッファの目標残量（APU サンプル数）。約 50ms。
const AUDIO_TARGET = Math.round(APU_SAMPLE_RATE * 0.05);
const AUDIO_MAX = Math.round(APU_SAMPLE_RATE * 0.12);

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const status_el = document.getElementById("status") as HTMLElement;
const fps_el = document.getElementById("fps") as HTMLElement;
const file_input = document.getElementById("rom") as HTMLInputElement;

const video = new Video(canvas);
const audio = new Audio();
const input = new Input();
const ramview = new RamViewer(document.getElementById("ramview") as HTMLElement);
const cheatpanel = new CheatPanel(document.getElementById("cheats") as HTMLElement);
// ビューアの更新間隔（毎フレームは不要。ダンプ 2048 セルの走査を抑える）。
const RAMVIEW_INTERVAL_MS = 100;
let ramview_time = 0;

let nes: Nes | null = null;
let rom_name = "";
let running = false;
let last_time = 0;
let frame_debt = 0;
let fps_frames = 0;
let fps_time = 0;
let battery_dirty = false;

function status(msg: string): void {
  status_el.textContent = msg;
}

function load_rom(name: string, bytes: Uint8Array): void {
  try {
    nes = Nes.power_on_from_rom(bytes);
  } catch (e) {
    status(`ROM 読み込み失敗: ${(e as Error).message}`);
    return;
  }
  rom_name = name;
  cheatpanel.attach(nes);
  // 保存済みチートがあれば復元。
  {
    const cht = load_cheats(name);
    if (cht !== null) nes.load_cheats_str(cht);
    cheatpanel.refresh();
  }
  // バッテリーセーブがあれば復元。
  if (nes.has_battery()) {
    const sav = load_battery(name);
    if (sav !== null) nes.load_battery_ram(sav);
  }
  running = true;
  last_time = performance.now();
  frame_debt = 0;
  status(`${name} を実行中`);
  void audio.start();
}

// ---- メインループ ----

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (nes === null || !running) return;

  // RAM ビューアで値を編集している間はゲーム入力を止める。
  const want_input = !ramview.editing;
  if (input.enabled !== want_input) {
    input.enabled = want_input;
    if (!want_input) input.release_all(nes);
  }
  input.poll_gamepads(nes);

  const turbo = input.turbo_active;
  const elapsed = Math.min(now - last_time, 100); // 長いストール時は取り戻さない
  last_time = now;

  let frames: number;
  if (turbo) {
    frames = 4; // ターボ: 描画 1 回あたり 4 フレーム進める
  } else {
    frame_debt += (elapsed * TARGET_FPS) / 1000;
    frames = Math.floor(frame_debt);
    frame_debt -= frames;
    // 音声バッファが溜まりすぎ/枯渇しているときに ±1 フレームで調整する。
    // （音声が動いていないときは rAF の実時間だけでペーシングする）
    if (audio.ready) {
      if (audio.buffered > AUDIO_MAX && frames > 0) frames--;
      else if (audio.buffered < AUDIO_TARGET / 2) frames++;
    }
    if (frames > 4) frames = 4; // 落ちたときの暴走防止
  }

  for (let i = 0; i < frames; i++) {
    nes.step_frame();
    const samples = nes.bus.apu.drain_output();
    if (!turbo) audio.push(samples);
  }
  if (frames > 0 && nes.has_battery()) battery_dirty = true;

  if (frames > 0) {
    video.draw(nes.framebuffer());
    fps_frames += frames;
  }

  if (ramview.is_open && now - ramview_time >= RAMVIEW_INTERVAL_MS) {
    ramview.render(nes);
    ramview_time = now;
  }

  if (now - fps_time >= 1000) {
    fps_el.textContent = `${fps_frames} fps${turbo ? " (turbo)" : ""}`;
    fps_frames = 0;
    fps_time = now;
  }
}

// キーボードは起動時に 1 度だけ購読する（ROM 差し替えでも張り替えない）。
input.attach(() => nes, window);
requestAnimationFrame(tick);

// ---- ROM 読み込み（ファイル選択 / ドラッグ&ドロップ）----

async function accept_file(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith(".cht")) {
    if (nes === null) {
      status("先に ROM を読み込んで");
      return;
    }
    const errs = nes.load_cheats_str(new TextDecoder().decode(bytes));
    persist_cheats();
    cheatpanel.refresh();
    status(`チート読み込み（エラー ${errs.length} 件）`);
    return;
  }
  if (file.name.toLowerCase().endsWith(".sav")) {
    if (nes === null) {
      status("先に ROM を読み込んで");
      return;
    }
    nes.load_battery_ram(bytes);
    save_battery(rom_name, nes.battery_ram());
    status(".sav を読み込んだ");
    return;
  }
  if (/\.state\d*$/i.test(file.name)) {
    if (nes === null) {
      status("先に ROM を読み込んで");
      return;
    }
    try {
      nes.load_state(bytes);
      status("セーブステートを読み込んだ");
    } catch (e) {
      status(`ステート読み込み失敗: ${(e as Error).message}`);
    }
    return;
  }
  load_rom(file.name, bytes);
}

file_input.addEventListener("change", () => {
  const f = file_input.files?.[0];
  if (f !== undefined) void accept_file(f);
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f !== undefined) void accept_file(f);
});

// ---- ホットキー ----

window.addEventListener("keydown", (e) => {
  // ビューアが編集中ならキーはそちらへ（ゲーム入力より優先）。
  if (ramview.handle_key(e.key)) {
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && e.code === "KeyM") {
    e.preventDefault();
    ramview.toggle();
    if (nes !== null && ramview.is_open) ramview.render(nes);
    status(ramview.is_open ? "RAM ビューア表示" : "RAM ビューア非表示");
    return;
  }
  if (ramview.is_open && (e.key === "<" || e.key === ">")) {
    e.preventDefault();
    ramview.cycle_view(e.key === ">" ? 1 : -1);
    if (nes !== null) ramview.render(nes);
    return;
  }
  if (nes === null) return;
  // F1-F10: ステート保存 / Ctrl+F1-F10: ロード
  const fmatch = /^F([1-9]|10)$/.exec(e.key);
  if (fmatch !== null) {
    const slot = parseInt(fmatch[1]!, 10);
    e.preventDefault();
    if (e.ctrlKey) {
      const data = load_state_slot(rom_name, slot);
      if (data === null) {
        status(`スロット ${slot}: 空`);
        return;
      }
      try {
        nes.load_state(data);
        status(`スロット ${slot} をロード`);
      } catch (err) {
        status(`ロード失敗: ${(err as Error).message}`);
      }
    } else {
      const ok = save_state_slot(rom_name, slot, nes.save_state());
      status(ok ? `スロット ${slot} に保存` : `スロット ${slot}: 保存失敗（容量不足）`);
    }
    return;
  }
  if (e.ctrlKey && e.code === "KeyH") {
    e.preventDefault();
    cheatpanel.toggle();
    status(cheatpanel.is_open ? "チートパネル表示" : "チートパネル非表示");
    return;
  }
  if (e.ctrlKey && e.code === "KeyR") {
    e.preventDefault();
    nes.soft_reset();
    status("リセット");
    return;
  }
  if (e.code === "KeyM") {
    status(audio.toggle_mute() ? "ミュート" : "ミュート解除");
    return;
  }
  if (e.code === "Digit8") {
    nes.bus.ppu.no_sprite_limit = !nes.bus.ppu.no_sprite_limit;
    status(`スプライト制限 ${nes.bus.ppu.no_sprite_limit ? "解除" : "有効"}`);
    return;
  }
  if (e.code === "KeyP") {
    running = !running;
    last_time = performance.now();
    status(running ? "再開" : "一時停止");
  }
});

// ---- ボタン UI ----

document.getElementById("btn-reset")?.addEventListener("click", () => {
  nes?.soft_reset();
  status("リセット");
});

document.getElementById("btn-save")?.addEventListener("click", () => {
  if (nes === null) return;
  download(`${rom_name.replace(/\.nes$/i, "")}.state1`, nes.save_state());
});

document.getElementById("btn-sav")?.addEventListener("click", () => {
  if (nes === null || !nes.has_battery()) {
    status("この ROM にバッテリーは無い");
    return;
  }
  download(`${rom_name.replace(/\.nes$/i, "")}.sav`, nes.battery_ram());
});

// チートの変更を保存し、`.cht` として書き出せるようにする。
function persist_cheats(): void {
  if (nes === null) return;
  save_cheats(rom_name, nes.bus.cheats.to_cht_text());
}
cheatpanel.on_change = persist_cheats;
cheatpanel.export_cht = () => {
  if (nes === null) return;
  download(`${rom_name.replace(/\.nes$/i, "")}.cht`, new TextEncoder().encode(nes.bus.cheats.to_cht_text()));
};

// バッテリー RAM を定期保存（cppnes の終了時書き戻しに相当）。
setInterval(() => {
  if (nes !== null && battery_dirty && nes.has_battery()) {
    save_battery(rom_name, nes.battery_ram());
    battery_dirty = false;
  }
}, 5000);

window.addEventListener("beforeunload", () => {
  if (nes !== null && nes.has_battery()) save_battery(rom_name, nes.battery_ram());
});

// クリックで音声を有効化（ブラウザの自動再生制限対策）。
canvas.addEventListener("click", () => void audio.start());

// デバッグ用フック（開発ビルドのみ。配布ビルドでは __TSNES_DEV__=false で落ちる）。
if (__TSNES_DEV__) {
  (window as unknown as { tsnes: unknown }).tsnes = {
    nes: () => nes,
    audio,
    input,
    get running() {
      return running;
    },
  };
}

// ?rom=<URL> が付いていればその ROM を自動で読み込む（開発サーバの /rom/... など）。
// 任意のサイトの ROM をリンク一発で起動させないよう、同一オリジンに限定する。
{
  const rom_url = new URLSearchParams(location.search).get("rom");
  if (rom_url !== null) {
    void (async () => {
      try {
        const resolved = new URL(rom_url, location.href);
        if (resolved.origin !== location.origin) {
          throw new Error("同一オリジンの ROM のみ自動読み込みできる");
        }
        const res = await fetch(resolved);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const name = decodeURIComponent(rom_url.split("/").pop() ?? "rom.nes");
        load_rom(name, new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        status(`ROM 取得失敗: ${(e as Error).message}`);
      }
    })();
  }
}
