// AudioWorklet プロセッサ本体（別エントリポイントとしてビルドされ、
// `audio.ts` から URL で読み込まれる）。
//
// APU が出すサンプル（約 44.1kHz）を受け取ってリングバッファに溜め、
// AudioContext のレートへ線形補間しながら出力する。
//
// 中核の RingResampler は AudioWorklet API に依存しない純粋クラスなので、
// `tests/audio_ring.test.ts` から単体で検証できる。

// APU サンプルを溜めてコンテキストレートへリサンプルするリングバッファ。
export class RingResampler {
  private readonly buf: Float32Array;
  private readonly mask: number;
  private head = 0; // 書き込み位置（累積）
  private tail = 0; // 読み出し位置（累積）
  private pos = 0; // tail からの小数位置
  private last = 0; // 直近の出力値（アンダーラン時に保持）
  private readonly ratio: number;

  constructor(src_rate: number, dst_rate: number, size = 1 << 16) {
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.ratio = src_rate / dst_rate;
  }

  // 溜まっている（まだ出力していない）サンプル数。
  get available(): number {
    return this.head - this.tail;
  }

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.head & this.mask] = chunk[i]!;
      this.head++;
    }
    // オーバーフローしたら古い分を捨てる。
    if (this.available > this.mask) {
      this.tail = this.head - (this.mask >> 1);
    }
  }

  // out を 1 サンプルずつ埋める。データ不足なら直近値を保持する。
  fill(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      if (this.available < 2) {
        // アンダーラン: 直近値を保持（クリック音を避ける）。
        out[i] = this.last;
        continue;
      }
      const a = this.buf[this.tail & this.mask]!;
      const b = this.buf[(this.tail + 1) & this.mask]!;
      const v = a + (b - a) * this.pos;
      out[i] = v;
      this.last = v;
      this.pos += this.ratio;
      while (this.pos >= 1) {
        this.pos -= 1;
        this.tail++;
      }
    }
  }
}

// ---- AudioWorklet 登録（ワークレット以外の環境では何もしない）----

declare const registerProcessor: ((name: string, ctor: unknown) => void) | undefined;
declare const sampleRate: number;
declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort };
};

if (typeof registerProcessor === "function") {
  class NesAudioProcessor extends AudioWorkletProcessor {
    private readonly ring: RingResampler;

    constructor(options: { processorOptions: { srcRate: number } }) {
      super();
      this.ring = new RingResampler(options.processorOptions.srcRate, sampleRate);
      this.port.onmessage = (e: MessageEvent) => {
        this.ring.push(e.data as Float32Array);
      };
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0]?.[0];
      if (out === undefined) return true;
      this.ring.fill(out);
      // 残量を主スレッドへ通知（フレームペーシングに使う）。
      this.port.postMessage(this.ring.available);
      return true;
    }
  }

  registerProcessor("nes-audio", NesAudioProcessor);
}
