// Mapper 69 (Sunsoft FME-7) — バンク + CPU レート IRQ + 拡張音源
// （移植元 cppnes `mapper/mapper69.hpp`）。Hebereke, Gimmick! 等。
import {
  type CartridgeData,
  Mapper,
  chr_rom_at,
  prg_rom_at,
  read_chr_rom_or_ram,
  read_prg_ram,
  write_chr_ram,
  write_prg_ram,
} from "../mapper.ts";
import type { StateReader, StateWriter } from "../savestate.ts";

const fr = Math.fround;

// YM2149 対数 4bit DAC（volume 15 → 1.0）。
// prettier-ignore
const FME7_VOLUME_TABLE = Float32Array.from([
  0.0, 0.0078, 0.011, 0.0156, 0.0221, 0.0312, 0.0442, 0.0625,
  0.0884, 0.125, 0.1768, 0.25, 0.3536, 0.5, 0.7071, 1.0,
]);

// 拡張音源の 1 チャンネル（矩形波）。
class Channel {
  period = 0;
  counter = 0;
  output = 0;
  enable = false;
  volume = 0;
  use_envelope = false;

  tick(cycles: number): void {
    const p = this.period === 0 ? 1 : this.period;
    const threshold = p * 16;
    for (let i = 0; i < cycles; i++) {
      this.counter = (this.counter + 1) & 0xffff;
      if (this.counter >= threshold) {
        this.counter = 0;
        this.output ^= 1;
      }
    }
  }
}

// 共有エンベロープジェネレータ。
class Envelope {
  period = 0;
  counter = 0;
  step = 0;
  shape = 0;
  output = 0;
  holding = false;

  tick(cycles: number): void {
    const div = (this.period === 0 ? 1 : this.period) * 256;
    for (let i = 0; i < cycles; i++) {
      this.counter++;
      if (this.counter < div) continue;
      this.counter = 0;
      if (this.holding) continue;
      this.advance();
    }
  }

  advance(): void {
    const attack = (this.shape & 0x04) !== 0;
    const alt = (this.shape & 0x02) !== 0;
    const hold = (this.shape & 0x01) !== 0;
    const cont = (this.shape & 0x08) !== 0;
    this.step = (this.step + 1) & 0xff;
    if (this.step < 16) {
      this.output = attack ? this.step : 15 - this.step;
      return;
    }
    if (!cont) {
      this.output = 0;
      this.holding = true;
      return;
    }
    if (hold) {
      this.output = alt ? (attack ? 0 : 15) : attack ? 15 : 0;
      this.holding = true;
    } else if (alt) {
      if (this.step >= 32) {
        this.step = 0;
        this.output = attack ? 0 : 15;
        return;
      }
      const sub = (this.step - 16) & 0xff;
      this.output = attack ? 15 - sub : sub;
    } else {
      this.step = 0;
      this.output = attack ? 0 : 15;
    }
  }
}

class Audio {
  reg_select = 0;
  readonly channels: [Channel, Channel, Channel] = [new Channel(), new Channel(), new Channel()];
  readonly envelope = new Envelope();

  write_select(value: number): void {
    this.reg_select = value & 0x0f;
  }

  write_data(value: number): void {
    switch (this.reg_select) {
      case 0:
      case 2:
      case 4: {
        const ch = this.channels[this.reg_select / 2]!;
        ch.period = ((ch.period & 0x0f00) | value) & 0xffff;
        break;
      }
      case 1:
      case 3:
      case 5: {
        const ch = this.channels[(this.reg_select - 1) / 2]!;
        ch.period = ((ch.period & 0x00ff) | ((value & 0x0f) << 8)) & 0xffff;
        break;
      }
      case 7:
        this.channels[0].enable = (value & 0x01) === 0;
        this.channels[1].enable = (value & 0x02) === 0;
        this.channels[2].enable = (value & 0x04) === 0;
        break;
      case 8:
      case 9:
      case 10: {
        const ch = this.channels[this.reg_select - 8]!;
        ch.use_envelope = (value & 0x10) !== 0;
        ch.volume = value & 0x0f;
        break;
      }
      case 11:
        this.envelope.period = ((this.envelope.period & 0xff00) | value) & 0xffff;
        break;
      case 12:
        this.envelope.period = ((this.envelope.period & 0x00ff) | (value << 8)) & 0xffff;
        break;
      case 13:
        this.envelope.shape = value & 0x0f;
        this.envelope.counter = 0;
        this.envelope.step = 0;
        this.envelope.holding = false;
        this.envelope.output = value & 0x04 ? 0 : 15;
        break;
      default:
        break;
    }
  }

  tick(cycles: number): void {
    for (const ch of this.channels) ch.tick(cycles);
    this.envelope.tick(cycles);
  }

  sample(): number {
    let sum = 0;
    for (const c of this.channels) {
      if (!c.enable || c.output === 0) continue;
      const vol = c.use_envelope ? this.envelope.output : c.volume;
      sum = fr(sum + FME7_VOLUME_TABLE[vol]!);
    }
    return fr(sum * fr(0.33));
  }
}

export class Mapper69 extends Mapper {
  private command_ = 0;
  private prg_ram_select_ = 0;
  private readonly prg_banks_ = new Uint8Array(3);
  private readonly chr_banks_ = new Uint8Array(8);
  private mirroring_ = 0;
  private irq_control_ = 0;
  private irq_counter_ = 0;
  private irq_pending_ = false;
  private readonly audio_ = new Audio();
  private readonly prg_bank_count_: number;
  private readonly chr_bank_count_: number;

  constructor(data: CartridgeData) {
    super(data);
    this.prg_bank_count_ =
      data.prg_rom.length === 0 ? 0 : Math.floor(data.prg_rom.length / 8192) & 0xff;
    this.chr_bank_count_ =
      data.chr_rom.length === 0 ? 0 : Math.floor(data.chr_rom.length / 1024) & 0xffff;
  }

  read_prg(addr: number): number {
    if (addr >= 0xe000) return this.read_prg_bank((this.prg_bank_count_ - 1) & 0xff, addr - 0xe000);
    if (addr >= 0xc000) return this.read_prg_bank(this.prg_banks_[2]!, addr - 0xc000);
    if (addr >= 0xa000) return this.read_prg_bank(this.prg_banks_[1]!, addr - 0xa000);
    if (addr >= 0x8000) return this.read_prg_bank(this.prg_banks_[0]!, addr - 0x8000);
    if (addr >= 0x6000) {
      if ((this.prg_ram_select_ & 0x80) === 0) return 0; // bit7=enable
      if (this.prg_ram_select_ & 0x40) return read_prg_ram(this.data_, addr); // bit6=RAM
      return this.read_prg_bank(this.prg_ram_select_ & 0x3f, addr - 0x6000);
    }
    return 0;
  }

  write_prg(addr: number, value: number): void {
    if (addr >= 0xe000) {
      this.audio_.write_data(value);
    } else if (addr >= 0xc000) {
      this.audio_.write_select(value);
    } else if (addr >= 0xa000) {
      this.write_param(value);
    } else if (addr >= 0x8000) {
      this.command_ = value & 0x0f;
    } else if (addr >= 0x6000 && (this.prg_ram_select_ & 0xc0) === 0xc0) {
      write_prg_ram(this.data_, addr, value);
    }
  }

  read_chr(addr: number): number {
    if (this.chr_bank_count_ === 0) return read_chr_rom_or_ram(this.data_, addr);
    const region = (addr >> 10) & 0x07;
    const bank = this.chr_banks_[region]! % this.chr_bank_count_;
    return chr_rom_at(this.data_, bank * 1024 + (addr & 0x3ff));
  }

  write_chr(addr: number, value: number): void {
    write_chr_ram(this.data_, addr, value);
  }

  is_irq_pending(): boolean {
    return this.irq_pending_;
  }
  clear_irq(): void {
    this.irq_pending_ = false;
  }
  is_irq_capable(): boolean {
    return true;
  }

  tick_cpu(cycles: number): void {
    this.audio_.tick(cycles);
    if ((this.irq_control_ & 0x80) === 0) return;
    for (let i = 0; i < cycles; i++) {
      if (this.irq_counter_ === 0) {
        this.irq_counter_ = 0xffff;
        if (this.irq_control_ & 0x01) this.irq_pending_ = true;
      } else {
        this.irq_counter_ = (this.irq_counter_ - 1) & 0xffff;
      }
    }
  }

  audio_sample(): number {
    return this.audio_.sample();
  }

  mirroring_mode(): number | null {
    switch (this.mirroring_) {
      case 0: return 1; // vertical
      case 1: return 0; // horizontal
      case 2: return 2; // single lower
      default: return 3; // single upper
    }
  }

  save_state(w: StateWriter): void {
    w.u8(this.command_);
    w.u8(this.prg_ram_select_);
    w.u8(this.mirroring_);
    w.u8(this.irq_control_);
    w.bytes(this.prg_banks_);
    w.bytes(this.chr_banks_);
    w.u16(this.irq_counter_);
    w.boolean(this.irq_pending_);
  }

  load_state(r: StateReader): void {
    this.command_ = r.u8();
    this.prg_ram_select_ = r.u8();
    this.mirroring_ = r.u8();
    this.irq_control_ = r.u8();
    r.read_into(this.prg_banks_);
    r.read_into(this.chr_banks_);
    this.irq_counter_ = r.u16();
    this.irq_pending_ = r.boolean();
  }

  private read_prg_bank(raw_bank: number, offset: number): number {
    if (this.prg_bank_count_ === 0) return 0;
    const bank = (raw_bank & 0x3f) % this.prg_bank_count_;
    return prg_rom_at(this.data_, bank * 8192 + offset);
  }

  private write_param(value: number): void {
    if (this.command_ <= 7) {
      this.chr_banks_[this.command_] = value;
    } else if (this.command_ === 8) {
      this.prg_ram_select_ = value;
    } else if (this.command_ <= 11) {
      this.prg_banks_[this.command_ - 9] = value & 0x3f;
    } else if (this.command_ === 12) {
      this.mirroring_ = value & 0x03;
    } else if (this.command_ === 13) {
      this.irq_control_ = value;
      this.irq_pending_ = false;
    } else if (this.command_ === 14) {
      this.irq_counter_ = ((this.irq_counter_ & 0xff00) | value) & 0xffff;
    } else if (this.command_ === 15) {
      this.irq_counter_ = ((this.irq_counter_ & 0x00ff) | (value << 8)) & 0xffff;
    }
  }
}
