// NES コントローラ（移植元 cppnes `input.hpp` / `input.cpp`）。
//
// $4016 ストローブ書き込みと 8 ビットシリアル読み出し。ストローブ high の間は
// 最初のボタン(A)を返し続け、low で 1 ビットずつシフトして返す。

// ボタンビット（set_button の button 引数 = ビット位置）。
export const BUTTON_A = 0;
export const BUTTON_B = 1;
export const BUTTON_SELECT = 2;
export const BUTTON_START = 3;
export const BUTTON_UP = 4;
export const BUTTON_DOWN = 5;
export const BUTTON_LEFT = 6;
export const BUTTON_RIGHT = 7;

// NES コントローラ 1 個分。
export class Controller {
  private buttons_ = 0;
  private strobe_ = false;
  private index_ = 0;

  // ボタン状態を設定する（controller は現状 0 のみ対応）。button はビット位置。
  set_button(controller: number, button: number, pressed: boolean): void {
    if (controller !== 0 || button > 7) {
      return;
    }
    const mask = (1 << button) & 0xff;
    if (pressed) {
      this.buttons_ = (this.buttons_ | mask) & 0xff;
    } else {
      this.buttons_ = this.buttons_ & ~mask & 0xff;
    }
  }

  // コントローラ状態を 1 ビット読む。ストローブ low なら index を進める。
  read(): number {
    if (this.index_ > 7) {
      return 1;
    }
    const result = (this.buttons_ >> this.index_) & 1;
    if (!this.strobe_) {
      this.index_++;
    }
    return result;
  }

  // $4016 書き込み（ストローブ）。
  write(value: number): void {
    this.strobe_ = (value & 1) !== 0;
    if (this.strobe_) {
      this.index_ = 0;
    }
  }

  // 現在のボタンビット全体。
  buttons(): number {
    return this.buttons_;
  }

  // 指定ボタン（ビットマスク）が押されているか。
  is_pressed(mask: number): boolean {
    return (this.buttons_ & mask) !== 0;
  }
}
