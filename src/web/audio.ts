// WebAudio 出力。APU の drain_output() を AudioWorklet のリングバッファへ流し込む。
//
// プロセッサ本体は `audio-worklet.ts`（別エントリポイントとしてビルドされる）。
// APU のサンプルレートは 1789773 / 40.5845578231293 ≒ 44100Hz。AudioContext が
// 別レートでも、ワークレット側で線形補間リサンプルして合わせる。

// APU が出すサンプルレート（cppnes の CYCLES_PER_SAMPLE と対応）。
export const APU_SAMPLE_RATE = 1789773 / 40.5845578231293;

const DEFAULT_VOLUME = 0.6;

export class Audio {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  // ワークレット側のバッファ残量（APU サンプル数）。
  buffered = 0;
  muted = false;

  async start(): Promise<void> {
    if (this.ctx !== null) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
    const node = new AudioWorkletNode(ctx, "nes-audio", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { srcRate: APU_SAMPLE_RATE },
    });
    node.port.onmessage = (e: MessageEvent) => {
      this.buffered = e.data as number;
    };
    const gain = ctx.createGain();
    gain.gain.value = DEFAULT_VOLUME;
    node.connect(gain).connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    if (ctx.state === "suspended") await ctx.resume();
  }

  push(samples: Float32Array): void {
    if (this.node === null || samples.length === 0) return;
    // APU が返すのは呼び出し側所有のコピーなので、そのまま転送してよい。
    this.node.port.postMessage(samples, [samples.buffer]);
  }

  toggle_mute(): boolean {
    this.muted = !this.muted;
    if (this.gain !== null) this.gain.gain.value = this.muted ? 0 : DEFAULT_VOLUME;
    return this.muted;
  }

  // ワークレットが実際に再生中か（自動再生制限で suspended の間は false）。
  get ready(): boolean {
    return this.node !== null && this.ctx !== null && this.ctx.state === "running";
  }
}
