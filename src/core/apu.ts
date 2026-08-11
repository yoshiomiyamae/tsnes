// Audio Processing Unit（移植元 cppnes `apu.hpp` / `apu.cpp`）。
//
// 5 チャンネル（矩形 ×2 / 三角 / ノイズ / DMC）+ フレームシーケンサ +
// フレーム/DMC IRQ + 非線形ミキサ + アナログ風フィルタチェーン。
// DMC サンプル DMA は step_n に渡す Cartridge（$C000-$FFFF = PRG ROM）から読む。
//
// C++ の `float` 演算は Math.fround() で f32 の丸めを再現する（PLAN.md 第 5 章）。
import type { Cartridge } from "./cartridge.ts";
import type { StateReader, StateWriter } from "./savestate.ts";

const fr = Math.fround;

// チャンネル ID（channel_mute の添字）。
export const CHANNEL_PULSE1 = 0;
export const CHANNEL_PULSE2 = 1;
export const CHANNEL_TRIANGLE = 2;
export const CHANNEL_NOISE = 3;
export const CHANNEL_DMC = 4;
export const NUM_CHANNELS = 5;

// テストからも参照するルックアップテーブル。
// prettier-ignore
export const LENGTH_TABLE = new Uint8Array([
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
]);

// prettier-ignore
export const NOISE_PERIODS = new Uint16Array([
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
]);

// prettier-ignore
const DUTY_CYCLES: readonly Uint8Array[] = [
  new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]), // 12.5%
  new Uint8Array([0, 1, 1, 0, 0, 0, 0, 0]), // 25%
  new Uint8Array([0, 1, 1, 1, 1, 0, 0, 0]), // 50%
  new Uint8Array([1, 0, 0, 1, 1, 1, 1, 1]), // 25% (negated)
];

// prettier-ignore
const TRIANGLE_SEQUENCE = new Uint8Array([
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

// prettier-ignore
const DMC_RATES = new Uint16Array([
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
]);

// ---- サブユニット ----

export class SweepUnit {
  enabled = false;
  period = 0;
  negate = false;
  shift = 0;
  reload = false;
  counter = 0;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.u8(this.period);
    w.boolean(this.negate);
    w.u8(this.shift);
    w.boolean(this.reload);
    w.u8(this.counter);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.period = r.u8();
    this.negate = r.boolean();
    this.shift = r.u8();
    this.reload = r.boolean();
    this.counter = r.u8();
  }
}

export class LengthCounter {
  enabled = false;
  value = 0;
  halt = false;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.u8(this.value);
    w.boolean(this.halt);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.value = r.u8();
    this.halt = r.boolean();
  }
}

export class EnvelopeGenerator {
  start = false;
  loop_flag = false;
  constant = false;
  volume = 0;
  counter = 0;
  divider = 0;

  save(w: StateWriter): void {
    w.boolean(this.start);
    w.boolean(this.loop_flag);
    w.boolean(this.constant);
    w.u8(this.volume);
    w.u8(this.counter);
    w.u8(this.divider);
  }
  load(r: StateReader): void {
    this.start = r.boolean();
    this.loop_flag = r.boolean();
    this.constant = r.boolean();
    this.volume = r.u8();
    this.counter = r.u8();
    this.divider = r.u8();
  }
}

// ---- チャンネル ----

export class PulseChannel {
  enabled = false;
  duty_cycle = 0;
  volume = 0;
  sweep = new SweepUnit();
  length = new LengthCounter();
  envelope = new EnvelopeGenerator();
  timer = 0;
  timer_value = 0;
  sequence = 0;
  sequencer_step = 0;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.u8(this.duty_cycle);
    w.u8(this.volume);
    this.sweep.save(w);
    this.length.save(w);
    this.envelope.save(w);
    w.u16(this.timer);
    w.u16(this.timer_value);
    w.u8(this.sequence);
    w.i32(this.sequencer_step);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.duty_cycle = r.u8();
    this.volume = r.u8();
    this.sweep.load(r);
    this.length.load(r);
    this.envelope.load(r);
    this.timer = r.u16();
    this.timer_value = r.u16();
    this.sequence = r.u8();
    this.sequencer_step = r.i32();
  }
}

export class TriangleChannel {
  enabled = false;
  linear_counter = 0;
  linear_reload = 0;
  linear_reload_flag = false;
  length = new LengthCounter();
  timer = 0;
  timer_value = 0;
  sequence = 0;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.u8(this.linear_counter);
    w.u8(this.linear_reload);
    w.boolean(this.linear_reload_flag);
    this.length.save(w);
    w.u16(this.timer);
    w.u16(this.timer_value);
    w.u8(this.sequence);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.linear_counter = r.u8();
    this.linear_reload = r.u8();
    this.linear_reload_flag = r.boolean();
    this.length.load(r);
    this.timer = r.u16();
    this.timer_value = r.u16();
    this.sequence = r.u8();
  }
}

export class NoiseChannel {
  enabled = false;
  volume = 0;
  length = new LengthCounter();
  envelope = new EnvelopeGenerator();
  timer = 0;
  timer_value = 0;
  shift_reg = 0;
  mode = false;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.u8(this.volume);
    this.length.save(w);
    this.envelope.save(w);
    w.u16(this.timer);
    w.u16(this.timer_value);
    w.u16(this.shift_reg);
    w.boolean(this.mode);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.volume = r.u8();
    this.length.load(r);
    this.envelope.load(r);
    this.timer = r.u16();
    this.timer_value = r.u16();
    this.shift_reg = r.u16();
    this.mode = r.boolean();
  }
}

export class DmcChannel {
  enabled = false;
  irq_enabled = false;
  loop_flag = false;
  rate = 0;
  load_counter = 0;
  sample_address = 0;
  sample_length = 0;
  current_address = 0;
  current_length = 0;
  buffer = 0;
  shift_reg = 0;
  bits_remaining = 0;
  timer = 0;
  silence = false;
  sample_buffer = 0;
  buffer_empty = false;
  // 非ループサンプル完走 + IRQ 有効でラッチ。
  interrupt_flag = false;

  save(w: StateWriter): void {
    w.boolean(this.enabled);
    w.boolean(this.irq_enabled);
    w.boolean(this.loop_flag);
    w.u8(this.rate);
    w.u8(this.load_counter);
    w.u16(this.sample_address);
    w.u16(this.sample_length);
    w.u16(this.current_address);
    w.u16(this.current_length);
    w.u8(this.buffer);
    w.u8(this.shift_reg);
    w.u8(this.bits_remaining);
    w.u16(this.timer);
    w.boolean(this.silence);
    w.u8(this.sample_buffer);
    w.boolean(this.buffer_empty);
    w.boolean(this.interrupt_flag);
  }
  load(r: StateReader): void {
    this.enabled = r.boolean();
    this.irq_enabled = r.boolean();
    this.loop_flag = r.boolean();
    this.rate = r.u8();
    this.load_counter = r.u8();
    this.sample_address = r.u16();
    this.sample_length = r.u16();
    this.current_address = r.u16();
    this.current_length = r.u16();
    this.buffer = r.u8();
    this.shift_reg = r.u8();
    this.bits_remaining = r.u8();
    this.timer = r.u16();
    this.silence = r.boolean();
    this.sample_buffer = r.u8();
    this.buffer_empty = r.boolean();
    this.interrupt_flag = r.boolean();
  }
}

// ---- 自由関数 ----

export function step_envelope(env: EnvelopeGenerator): void {
  if (env.start) {
    env.start = false;
    env.counter = 15;
    env.divider = env.volume;
  } else if (env.divider > 0) {
    env.divider = (env.divider - 1) & 0xff;
  } else {
    env.divider = env.volume;
    if (env.counter > 0) {
      env.counter = (env.counter - 1) & 0xff;
    } else if (env.loop_flag) {
      env.counter = 15;
    }
  }
}

export function step_length_counter(lc: LengthCounter): void {
  if (lc.enabled && !lc.halt && lc.value > 0) {
    lc.value = (lc.value - 1) & 0xff;
  }
}

export function get_frequency(timer_value: number): number {
  if (timer_value === 0) return 0;
  return fr(fr(1789773) / fr(fr(16) * fr(timer_value + 1)));
}

export function get_period(frequency: number): number {
  if (frequency === 0) return 0;
  const period = fr(fr(1789773 / fr(16 * frequency)) - 1);
  if (period < 0) return 0;
  if (period > 0x7ff) return 0x7ff;
  return Math.trunc(period);
}

// ---- 内部ヘルパ ----

// timer をデクリメントし、0 になったら reload して true を返す。
function tick_timer(ch: { timer: number }, reload: number): boolean {
  if (ch.timer === 0) {
    ch.timer = reload;
    return true;
  }
  ch.timer = (ch.timer - 1) & 0xffff;
  return false;
}

function step_pulse(pulse: PulseChannel): void {
  pulse.sequencer_step += 1;
  if (pulse.sequencer_step >= 2) {
    pulse.sequencer_step = 0;
    if (tick_timer(pulse, pulse.timer_value)) {
      pulse.sequence = (pulse.sequence + 1) % 8;
    }
  }
}

function perform_sweep_fn(pulse: PulseChannel, sweep: SweepUnit, channel1: boolean): void {
  const change = (pulse.timer_value >> sweep.shift) & 0xffff;
  let target: number;
  if (sweep.negate) {
    target = channel1
      ? (pulse.timer_value - change - 1) & 0xffff
      : (pulse.timer_value - change) & 0xffff;
  } else {
    target = (pulse.timer_value + change) & 0xffff;
  }
  if (target >= 8 && target <= 0x7ff) {
    pulse.timer_value = target;
  }
}

function step_sweep(pulse: PulseChannel, channel1: boolean): void {
  const sweep = pulse.sweep;
  if (sweep.reload) {
    sweep.counter = sweep.period;
    sweep.reload = false;
    if (sweep.enabled && sweep.period === 0) {
      perform_sweep_fn(pulse, sweep, channel1);
    }
  } else if (sweep.counter > 0) {
    sweep.counter = (sweep.counter - 1) & 0xff;
  } else {
    sweep.counter = sweep.period;
    if (sweep.enabled) {
      perform_sweep_fn(pulse, sweep, channel1);
    }
  }
}

function is_sweep_muting(pulse: PulseChannel): boolean {
  const sweep = pulse.sweep;
  if (!sweep.enabled) {
    return false;
  }
  const change = (pulse.timer_value >> sweep.shift) & 0xffff;
  let target: number;
  if (sweep.negate) {
    if (change <= pulse.timer_value) {
      target = (pulse.timer_value - change) & 0xffff;
    } else {
      return true; // アンダーフロー
    }
  } else {
    target = (pulse.timer_value + change) & 0xffff;
  }
  return !(target >= 8 && target <= 0x7ff);
}

// ミキサ/フィルタの float 定数（C++ の float リテラルと同じ値に丸める）。
const F_95_88 = fr(95.88);
const F_8128 = fr(8128);
const F_100 = fr(100);
const F_159_79 = fr(159.79);
const F_8227 = fr(8227);
const F_12241 = fr(12241);
const F_22638 = fr(22638);
const HPF90_ALPHA = fr(0.9873);
const LPF14K_ALPHA = fr(0.6661);
const LPF14K_FEEDBACK = fr(1 - LPF14K_ALPHA);

const CHANNEL_NAMES = ["Pulse1", "Pulse2", "Triangle", "Noise", "DMC"];

// 出力バッファ。C++ は 2048 を超えたら末尾 1024 だけ残すので同じ規則にする。
const OUTPUT_TRIM_THRESHOLD = 2048;
const OUTPUT_TRIM_KEEP = 1024;
const OUTPUT_CAPACITY = OUTPUT_TRIM_THRESHOLD + 1;

const CYCLES_PER_SAMPLE = 40.5845578231293;

export class Apu {
  pulse1 = new PulseChannel();
  pulse2 = new PulseChannel();
  triangle = new TriangleChannel();
  noise = new NoiseChannel();
  dmc = new DmcChannel();

  frame_counter = 0;
  frame_step = 0;
  frame_irq = false;
  frame_cycle_count = 0;
  cycles = 0;

  sample_accumulator = 0;
  // 生成済みサンプル。C++ の std::vector<float> に対応するが、毎サンプルの push と
  // 容量倍増を避けるため固定長 Float32Array + 書き込み位置で持つ。値は Math.fround
  // 済みなので f32 格納でビット同一。
  private readonly output_ = new Float32Array(OUTPUT_CAPACITY);
  private output_len_ = 0;

  readonly channel_mute = [false, false, false, false, false];
  filter_enabled = true;

  private hpf_prev_in_ = 0;
  private hpf_prev_out_ = 0;
  private lpf_prev_out_ = 0;

  constructor() {
    this.initialize_channels();
  }

  reset(): void {
    // C++ の `pulse1 = PulseChannel{};` 相当（既定値のインスタンスで置き換える）。
    this.pulse1 = new PulseChannel();
    this.pulse2 = new PulseChannel();
    this.triangle = new TriangleChannel();
    this.noise = new NoiseChannel();
    this.dmc = new DmcChannel();
    this.frame_counter = 0;
    this.frame_step = 0;
    this.frame_irq = false;
    this.cycles = 0;
    this.initialize_channels();
  }

  private initialize_channels(): void {
    this.noise.shift_reg = 1;
    this.pulse1.envelope.volume = 15;
    this.pulse2.envelope.volume = 15;
    this.noise.envelope.volume = 15;
    this.pulse1.length.enabled = true;
    this.pulse2.length.enabled = true;
    this.triangle.length.enabled = true;
    this.noise.length.enabled = true;
    this.dmc.buffer_empty = true;
    this.dmc.load_counter = 0;
    this.dmc.timer = (DMC_RATES[this.dmc.rate & 0x0f]! - 1) & 0xffff;
  }

  toggle_channel_mute(ch: number): { muted: boolean; name: string } {
    if (ch >= NUM_CHANNELS) return { muted: false, name: "" };
    this.channel_mute[ch] = !this.channel_mute[ch];
    return { muted: this.channel_mute[ch]!, name: CHANNEL_NAMES[ch]! };
  }

  toggle_filter(): boolean {
    this.filter_enabled = !this.filter_enabled;
    return this.filter_enabled;
  }

  // 生成済みサンプルを取り出してバッファを空にする（呼び出し側が所有するコピー）。
  drain_output(): Float32Array {
    const out = this.output_.slice(0, this.output_len_);
    this.output_len_ = 0;
    return out;
  }

  // 未排出サンプル数（テスト/フロントエンドのペーシング用）。
  get output_length(): number {
    return this.output_len_;
  }

  step(cart: Cartridge | null): void {
    this.step_n(1, cart);
  }

  step_n(n: number, cart: Cartridge | null): void {
    for (let i = 0; i < n; i++) {
      this.cycles += 1;

      this.frame_cycle_count += 1;
      if (this.frame_cycle_count >= 7458) {
        this.frame_cycle_count = 0;
        this.step_frame_counter();
      }

      if (this.pulse1.enabled) step_pulse(this.pulse1);
      if (this.pulse2.enabled) step_pulse(this.pulse2);
      if (this.triangle.enabled) this.step_triangle();
      if (this.noise.enabled) this.step_noise();
      if (this.dmc.enabled) this.step_dmc(cart);

      this.sample_accumulator += 1;
      if (this.sample_accumulator >= CYCLES_PER_SAMPLE) {
        this.sample_accumulator -= CYCLES_PER_SAMPLE;
        const expansion = cart !== null ? cart.audio_sample() : 0;
        this.output_[this.output_len_++] = this.mix_channels(expansion);
        if (this.output_len_ > OUTPUT_TRIM_THRESHOLD) {
          // 排出されないまま溜まったら古い分を捨てる（C++ と同じトリム規則）。
          this.output_.copyWithin(0, this.output_len_ - OUTPUT_TRIM_KEEP, this.output_len_);
          this.output_len_ = OUTPUT_TRIM_KEEP;
        }
      }
    }
  }

  private step_frame_counter(): void {
    if (this.frame_counter & 0x80) {
      // 5-step モード
      switch (this.frame_step) {
        case 0:
        case 2:
          this.step_envelopes();
          this.step_linear_counter();
          break;
        case 1:
        case 3:
          this.step_envelopes();
          this.step_linear_counter();
          this.step_length_counters();
          this.step_sweeps();
          break;
        default:
          break;
      }
      this.frame_step = (this.frame_step + 1) % 5;
    } else {
      // 4-step モード（既定）
      switch (this.frame_step) {
        case 0:
        case 2:
          this.step_envelopes();
          this.step_linear_counter();
          break;
        case 1:
        case 3:
          this.step_envelopes();
          this.step_linear_counter();
          this.step_length_counters();
          this.step_sweeps();
          if (this.frame_step === 3 && (this.frame_counter & 0x40) === 0) {
            this.frame_irq = true;
          }
          break;
        default:
          break;
      }
      this.frame_step = (this.frame_step + 1) % 4;
    }
  }

  private step_envelopes(): void {
    step_envelope(this.pulse1.envelope);
    step_envelope(this.pulse2.envelope);
    step_envelope(this.noise.envelope);
  }

  private step_length_counters(): void {
    step_length_counter(this.pulse1.length);
    step_length_counter(this.pulse2.length);
    step_length_counter(this.triangle.length);
    step_length_counter(this.noise.length);
  }

  step_sweeps(): void {
    step_sweep(this.pulse1, true);
    step_sweep(this.pulse2, false);
  }

  private step_triangle(): void {
    if (
      tick_timer(this.triangle, this.triangle.timer_value) &&
      this.triangle.length.value > 0 &&
      this.triangle.linear_counter > 0
    ) {
      this.triangle.sequence = (this.triangle.sequence + 1) % 32;
    }
  }

  private step_noise(): void {
    if (tick_timer(this.noise, this.noise.timer_value)) {
      const bit = this.noise.mode
        ? (this.noise.shift_reg & 1) ^ ((this.noise.shift_reg >> 6) & 1)
        : (this.noise.shift_reg & 1) ^ ((this.noise.shift_reg >> 1) & 1);
      this.noise.shift_reg = ((this.noise.shift_reg >> 1) | (bit << 14)) & 0xffff;
    }
  }

  private step_dmc(cart: Cartridge | null): void {
    const reload = (DMC_RATES[this.dmc.rate & 0x0f]! - 1) & 0xffff;
    if (tick_timer(this.dmc, reload)) {
      this.step_dmc_sample(cart);
    }
  }

  private step_dmc_sample(cart: Cartridge | null): void {
    const dmc = this.dmc;
    // メモリリーダ: 空ならサンプルバッファを補充（DMC サンプルは $C000+ = PRG）。
    if (dmc.buffer_empty && dmc.current_length > 0) {
      if (cart !== null) dmc.sample_buffer = cart.read_prg(dmc.current_address);
      dmc.buffer_empty = false;
      if (dmc.current_address === 0xffff) {
        dmc.current_address = 0x8000;
      } else {
        dmc.current_address = (dmc.current_address + 1) & 0xffff;
      }
      dmc.current_length = (dmc.current_length - 1) & 0xffff;
      if (dmc.current_length === 0) {
        if (dmc.loop_flag) {
          dmc.current_length = dmc.sample_length;
          dmc.current_address = dmc.sample_address;
        } else if (dmc.irq_enabled) {
          dmc.interrupt_flag = true;
        }
      }
    }

    // 出力ユニット: 1 ビット出力（LSB first）。
    if (dmc.bits_remaining > 0) {
      if (!dmc.silence) {
        if (dmc.buffer & 1) {
          if (dmc.load_counter <= 125) dmc.load_counter = (dmc.load_counter + 2) & 0xff;
        } else if (dmc.load_counter >= 2) {
          dmc.load_counter = (dmc.load_counter - 2) & 0xff;
        }
      }
      dmc.buffer = (dmc.buffer >> 1) & 0xff;
      dmc.bits_remaining = (dmc.bits_remaining - 1) & 0xff;
    }

    // 新しい 8 ビットサイクル。
    if (dmc.bits_remaining === 0) {
      dmc.bits_remaining = 8;
      if (dmc.buffer_empty) {
        dmc.silence = true;
      } else {
        dmc.buffer = dmc.sample_buffer;
        dmc.buffer_empty = true;
        dmc.silence = false;
      }
    }
  }

  private step_linear_counter(): void {
    const triangle = this.triangle;
    if (triangle.linear_reload_flag) {
      triangle.linear_counter = triangle.linear_reload;
    } else if (triangle.linear_counter > 0) {
      triangle.linear_counter = (triangle.linear_counter - 1) & 0xff;
    }
    if (!triangle.length.halt) {
      triangle.linear_reload_flag = false;
    }
  }

  get_pulse_output(pulse: PulseChannel): number {
    if (!pulse.enabled || pulse.length.value === 0) return 0;
    if (pulse.timer_value < 8 || pulse.timer_value > 0x7ff) return 0;
    if (is_sweep_muting(pulse)) return 0;
    if (DUTY_CYCLES[pulse.duty_cycle]![pulse.sequence] === 0) return 0;
    return pulse.envelope.constant ? pulse.volume : pulse.envelope.counter;
  }

  private get_triangle_output(): number {
    if (!this.triangle.enabled || this.triangle.length.value === 0 || this.triangle.linear_counter === 0)
      return 0;
    return TRIANGLE_SEQUENCE[this.triangle.sequence]!;
  }

  private get_noise_output(): number {
    if (!this.noise.enabled || this.noise.length.value === 0) return 0;
    if (this.noise.shift_reg & 1) return 0;
    return this.noise.envelope.constant ? this.noise.volume : this.noise.envelope.counter;
  }

  private get_dmc_output(): number {
    return this.dmc.enabled ? this.dmc.load_counter : 0;
  }

  mix_channels(expansion: number): number {
    let pulse1_o = this.get_pulse_output(this.pulse1);
    let pulse2_o = this.get_pulse_output(this.pulse2);
    let triangle_o = this.get_triangle_output();
    let noise_o = this.get_noise_output();
    let dmc_o = this.get_dmc_output();

    if (this.channel_mute[CHANNEL_PULSE1]) pulse1_o = 0;
    if (this.channel_mute[CHANNEL_PULSE2]) pulse2_o = 0;
    if (this.channel_mute[CHANNEL_TRIANGLE]) triangle_o = 0;
    if (this.channel_mute[CHANNEL_NOISE]) noise_o = 0;
    if (this.channel_mute[CHANNEL_DMC]) dmc_o = 0;

    // NESdev 非線形ミキサ。出力は自然に 0..1.0。
    const pulse_sum = pulse1_o + pulse2_o;
    const pulse_out = pulse_sum > 0 ? fr(F_95_88 / fr(fr(F_8128 / pulse_sum) + F_100)) : 0;
    const tnd_sum = fr(fr(fr(triangle_o / F_8227) + fr(noise_o / F_12241)) + fr(dmc_o / F_22638));
    const tnd_out = tnd_sum > 0 ? fr(F_159_79 / fr(fr(1 / tnd_sum) + F_100)) : 0;

    let out = fr(fr(pulse_out + tnd_out) + expansion);
    if (out > 1) out = 1;
    if (this.filter_enabled) out = this.apply_analog_filters(out);
    return out;
  }

  private apply_analog_filters(x: number): number {
    const hp = fr(HPF90_ALPHA * fr(fr(this.hpf_prev_out_ + x) - this.hpf_prev_in_));
    this.hpf_prev_in_ = x;
    this.hpf_prev_out_ = hp;
    const lp = fr(fr(LPF14K_ALPHA * hp) + fr(LPF14K_FEEDBACK * this.lpf_prev_out_));
    this.lpf_prev_out_ = lp;
    return lp;
  }

  // ---- レジスタ I/O ----

  read_register(addr: number): number {
    if (addr === 0x4015) {
      let status = 0;
      if (this.pulse1.length.value > 0) status |= 0x01;
      if (this.pulse2.length.value > 0) status |= 0x02;
      if (this.triangle.length.value > 0) status |= 0x04;
      if (this.noise.length.value > 0) status |= 0x08;
      if (this.dmc.current_length > 0) status |= 0x10;
      if (this.frame_irq) status |= 0x40;
      if (this.dmc.interrupt_flag) status |= 0x80;
      this.frame_irq = false; // ステータス読みでフレーム IRQ クリア
      return status;
    }
    return 0;
  }

  write_register(addr: number, value: number): void {
    if (addr >= 0x4000 && addr <= 0x4003) {
      this.write_pulse(true, addr - 0x4000, value);
    } else if (addr >= 0x4004 && addr <= 0x4007) {
      this.write_pulse(false, addr - 0x4004, value);
    } else if (addr >= 0x4008 && addr <= 0x400b) {
      this.write_triangle(addr - 0x4008, value);
    } else if (addr >= 0x400c && addr <= 0x400f) {
      this.write_noise(addr - 0x400c, value);
    } else if (addr >= 0x4010 && addr <= 0x4013) {
      this.write_dmc(addr - 0x4010, value);
    } else if (addr === 0x4015) {
      this.write_status(value);
    } else if (addr === 0x4017) {
      this.write_frame_counter(value);
    }
  }

  private write_pulse(is_pulse1: boolean, reg: number, value: number): void {
    const pulse = is_pulse1 ? this.pulse1 : this.pulse2;
    switch (reg) {
      case 0:
        pulse.duty_cycle = (value >> 6) & 0x03;
        pulse.length.halt = (value & 0x20) !== 0;
        pulse.envelope.loop_flag = (value & 0x20) !== 0;
        pulse.envelope.constant = (value & 0x10) !== 0;
        pulse.volume = value & 0x0f;
        pulse.envelope.volume = value & 0x0f;
        break;
      case 1:
        pulse.sweep.enabled = (value & 0x80) !== 0;
        pulse.sweep.period = (value >> 4) & 0x07;
        pulse.sweep.negate = (value & 0x08) !== 0;
        pulse.sweep.shift = value & 0x07;
        pulse.sweep.reload = true;
        break;
      case 2:
        pulse.timer_value = ((pulse.timer_value & 0xff00) | value) & 0xffff;
        break;
      default:
        pulse.timer_value = ((pulse.timer_value & 0x00ff) | ((value & 0x07) << 8)) & 0xffff;
        if (pulse.enabled) pulse.length.value = LENGTH_TABLE[(value >> 3) & 0x1f]!;
        pulse.envelope.start = true;
        pulse.sequence = 0;
        break;
    }
  }

  private write_triangle(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.triangle.length.halt = (value & 0x80) !== 0;
        this.triangle.linear_reload = value & 0x7f;
        break;
      case 2:
        this.triangle.timer_value = ((this.triangle.timer_value & 0xff00) | value) & 0xffff;
        break;
      case 3:
        this.triangle.timer_value =
          ((this.triangle.timer_value & 0x00ff) | ((value & 0x07) << 8)) & 0xffff;
        if (this.triangle.enabled) this.triangle.length.value = LENGTH_TABLE[(value >> 3) & 0x1f]!;
        this.triangle.linear_reload_flag = true;
        break;
      default:
        break; // $4009 unused
    }
  }

  private write_noise(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.noise.length.halt = (value & 0x20) !== 0;
        this.noise.envelope.loop_flag = (value & 0x20) !== 0;
        this.noise.envelope.constant = (value & 0x10) !== 0;
        this.noise.volume = value & 0x0f;
        this.noise.envelope.volume = value & 0x0f;
        break;
      case 2:
        this.noise.mode = (value & 0x80) !== 0;
        this.noise.timer_value = NOISE_PERIODS[value & 0x0f]!;
        break;
      case 3:
        if (this.noise.enabled) this.noise.length.value = LENGTH_TABLE[(value >> 3) & 0x1f]!;
        this.noise.envelope.start = true;
        break;
      default:
        break; // $400D unused
    }
  }

  private write_dmc(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.dmc.irq_enabled = (value & 0x80) !== 0;
        if (!this.dmc.irq_enabled) this.dmc.interrupt_flag = false;
        this.dmc.loop_flag = (value & 0x40) !== 0;
        this.dmc.rate = value & 0x0f;
        break;
      case 1:
        this.dmc.load_counter = value & 0x7f;
        break;
      case 2:
        this.dmc.sample_address = (0xc000 + value * 64) & 0xffff;
        break;
      default:
        this.dmc.sample_length = (value * 16 + 1) & 0xffff;
        break;
    }
  }

  private write_status(value: number): void {
    this.pulse1.enabled = (value & 0x01) !== 0;
    this.pulse2.enabled = (value & 0x02) !== 0;
    this.triangle.enabled = (value & 0x04) !== 0;
    this.noise.enabled = (value & 0x08) !== 0;
    this.dmc.enabled = (value & 0x10) !== 0;
    this.dmc.interrupt_flag = false;

    if (!this.pulse1.enabled) this.pulse1.length.value = 0;
    if (!this.pulse2.enabled) this.pulse2.length.value = 0;
    if (!this.triangle.enabled) this.triangle.length.value = 0;
    if (!this.noise.enabled) this.noise.length.value = 0;
    if (!this.dmc.enabled) {
      this.dmc.current_length = 0;
    } else if (this.dmc.current_length === 0) {
      this.dmc.current_length = this.dmc.sample_length;
      this.dmc.current_address = this.dmc.sample_address;
    }
  }

  private write_frame_counter(value: number): void {
    this.frame_counter = value;
    this.frame_step = 0;
    if (value & 0x80) {
      this.step_envelopes();
      this.step_length_counters();
      this.step_sweeps();
    }
    if (value & 0x40) {
      this.frame_irq = false;
    }
  }

  save_state(w: StateWriter): void {
    this.pulse1.save(w);
    this.pulse2.save(w);
    this.triangle.save(w);
    this.noise.save(w);
    this.dmc.save(w);
    w.u8(this.frame_counter);
    w.i32(this.frame_step);
    w.boolean(this.frame_irq);
    w.i32(this.frame_cycle_count);
    w.u64(this.cycles);
    w.f64(this.sample_accumulator);
    w.f32(this.hpf_prev_in_);
    w.f32(this.hpf_prev_out_);
    w.f32(this.lpf_prev_out_);
  }

  load_state(r: StateReader): void {
    this.pulse1.load(r);
    this.pulse2.load(r);
    this.triangle.load(r);
    this.noise.load(r);
    this.dmc.load(r);
    this.frame_counter = r.u8();
    this.frame_step = r.i32();
    this.frame_irq = r.boolean();
    this.frame_cycle_count = r.i32();
    this.cycles = r.u64();
    this.sample_accumulator = r.f64();
    this.hpf_prev_in_ = r.f32();
    this.hpf_prev_out_ = r.f32();
    this.lpf_prev_out_ = r.f32();
    this.output_len_ = 0;
  }
}
