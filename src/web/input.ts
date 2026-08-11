// キーボード / ゲームパッド入力（既定キーは cppnes の GUI と同じ）。
//
//   Z=A  X=B  A=Select  S=Start  矢印=十字  Tab=ターボ
import {
  BUTTON_A,
  BUTTON_B,
  BUTTON_DOWN,
  BUTTON_LEFT,
  BUTTON_RIGHT,
  BUTTON_SELECT,
  BUTTON_START,
  BUTTON_UP,
} from "../core/input.ts";
import type { Nes } from "../core/nes.ts";

// KeyboardEvent.code → NES ボタン。
export const DEFAULT_KEYMAP: Record<string, number> = {
  KeyZ: BUTTON_A,
  KeyX: BUTTON_B,
  KeyA: BUTTON_SELECT,
  KeyS: BUTTON_START,
  ArrowUp: BUTTON_UP,
  ArrowDown: BUTTON_DOWN,
  ArrowLeft: BUTTON_LEFT,
  ArrowRight: BUTTON_RIGHT,
};

// 標準ゲームパッドのボタン番号 → NES ボタン（1P/2P 共通）。
const PAD_BUTTONS: Record<number, number> = {
  0: BUTTON_A, // A / ✕
  1: BUTTON_B, // B / ○
  2: BUTTON_B, // X（B の別割当）
  3: BUTTON_A, // Y（A の別割当）
  8: BUTTON_SELECT,
  9: BUTTON_START,
  12: BUTTON_UP,
  13: BUTTON_DOWN,
  14: BUTTON_LEFT,
  15: BUTTON_RIGHT,
};

const AXIS_DEADZONE = 0.35;
const TRIGGER_THRESHOLD = 0.5;

export class Input {
  keymap = { ...DEFAULT_KEYMAP };
  turbo = false;
  // false の間はキーボード入力を無視する（RAM ビューアの編集中など）。
  enabled = true;
  // パッドの L2 でターボ反転（cppnes と同じ）。
  private pad_turbo = false;
  // poll_gamepads の作業用（毎フレームの配列確保を避ける）。
  private readonly pad_state_ = new Uint8Array(8);

  // キーイベントを購読する。ROM 差し替えでリスナが積み上がらないよう、
  // Nes は束縛せず get_nes() で毎回取り出す（poll_gamepads と同じ形）。
  attach(get_nes: () => Nes | null, target: Window): void {
    target.addEventListener("keydown", (e) => {
      const nes = get_nes();
      if (nes === null || !this.enabled) return;
      if (e.code === "Tab") {
        this.turbo = true;
        e.preventDefault();
        return;
      }
      const b = this.keymap[e.code];
      if (b !== undefined) {
        nes.set_button(0, b, true);
        e.preventDefault();
      }
    });
    target.addEventListener("keyup", (e) => {
      const nes = get_nes();
      if (nes === null || !this.enabled) return;
      if (e.code === "Tab") {
        this.turbo = false;
        e.preventDefault();
        return;
      }
      const b = this.keymap[e.code];
      if (b !== undefined) {
        nes.set_button(0, b, false);
        e.preventDefault();
      }
    });
    // フォーカスを失ったらボタンを離す（押しっぱなし防止）。
    target.addEventListener("blur", () => {
      const nes = get_nes();
      if (nes !== null) {
        for (let p = 0; p < 2; p++) for (let b = 0; b < 8; b++) nes.set_button(p, b, false);
      }
      this.turbo = false;
    });
  }

  // 全ボタンを離す（入力を無効化するときの押しっぱなし防止）。
  release_all(nes: Nes): void {
    for (let p = 0; p < 2; p++) for (let b = 0; b < 8; b++) nes.set_button(p, b, false);
    this.turbo = false;
  }

  // 毎フレーム呼ぶ。接続中のパッド（最大 2 台）を 1P/2P に貼る。
  poll_gamepads(nes: Nes): void {
    if (!this.enabled) return;
    if (typeof navigator === "undefined" || navigator.getGamepads === undefined) return;
    const pads = navigator.getGamepads();
    let any_turbo = false;
    let player = 0;
    for (const pad of pads) {
      if (player > 1) break;
      if (pad === null) continue;
      const state = this.pad_state_;
      state.fill(0);
      for (let i = 0; i < pad.buttons.length; i++) {
        const nes_button = PAD_BUTTONS[i];
        if (nes_button !== undefined && pad.buttons[i]!.pressed) state[nes_button] = 1;
      }
      // 左スティック → 十字キー。
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (ax < -AXIS_DEADZONE) state[BUTTON_LEFT] = 1;
      if (ax > AXIS_DEADZONE) state[BUTTON_RIGHT] = 1;
      if (ay < -AXIS_DEADZONE) state[BUTTON_UP] = 1;
      if (ay > AXIS_DEADZONE) state[BUTTON_DOWN] = 1;
      for (let b = 0; b < 8; b++) nes.set_button(player, b, state[b] !== 0);
      // L2（button 6）押下中はターボ反転。
      const l2 = pad.buttons[6];
      if (l2 !== undefined && (l2.pressed || l2.value > TRIGGER_THRESHOLD)) any_turbo = true;
      player++;
    }
    this.pad_turbo = any_turbo;
  }

  get turbo_active(): boolean {
    return this.turbo !== this.pad_turbo; // XOR（パッド L2 で反転）
  }
}
