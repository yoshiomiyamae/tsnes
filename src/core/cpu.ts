// 6502 CPU（移植元 cppnes `cpu.hpp` / `cpu.cpp`）。
//
// Cpu はレジスタ／割り込み状態のみを持ち、メモリアクセスを伴うメソッドは Bus を
// 引数で受け取る。Nes が cpu と bus を別フィールドで所有し cpu.step(bus) と駆動する。
// 命令ディスパッチは switch（V8 がジャンプテーブルに最適化）。
//
// C++ の `std::pair<uint16_t,bool>` 戻り値は、割り当てを避けるため
// 「戻り値 + `page_crossed` フィールド」へ分解している（PLAN.md 第 5 章）。
import type { Bus } from "./bus.ts";
import type { StateReader, StateWriter } from "./savestate.ts";

// ステータスフラグビット。
export const FLAG_CARRY = 1 << 0; // C
export const FLAG_ZERO = 1 << 1; // Z
export const FLAG_INTERRUPT = 1 << 2; // I
export const FLAG_DECIMAL = 1 << 3; // D
export const FLAG_BREAK = 1 << 4; // B
export const FLAG_UNUSED = 1 << 5; // -
export const FLAG_OVERFLOW = 1 << 6; // V
export const FLAG_NEGATIVE = 1 << 7; // N

// アドレッシングモード。
export enum AddressingMode {
  Implied,
  Accumulator,
  Immediate,
  ZeroPage,
  ZeroPageX,
  ZeroPageY,
  Relative,
  Absolute,
  AbsoluteX,
  AbsoluteY,
  Indirect,
  IndexedIndirect, // (zp,X)
  IndirectIndexed, // (zp),Y
}

const {
  Implied,
  Accumulator,
  Immediate,
  ZeroPage,
  ZeroPageX,
  ZeroPageY,
  Relative,
  Absolute,
  AbsoluteX,
  AbsoluteY,
  Indirect,
  IndexedIndirect,
  IndirectIndexed,
} = AddressingMode;

// implied/accumulator/stack 系の cycle-2 ダミーフェッチが必要なオペコードか。
function needs_dummy_fetch(op: number): boolean {
  switch (op) {
    case 0x00: case 0x40: case 0x60: // BRK, RTI, RTS
    case 0x08: case 0x28: case 0x48: case 0x68: // PHP, PLP, PHA, PLA
    case 0x0a: case 0x2a: case 0x4a: case 0x6a: // ASL/ROL/LSR/ROR A
    case 0x18: case 0x38: case 0x58: case 0x78: case 0xb8: case 0xd8: case 0xf8: // フラグ
    case 0x88: case 0x8a: case 0x98: case 0x9a: case 0xa8: case 0xaa: case 0xba:
    case 0xc8: case 0xca: case 0xe8: // 転送/inc-dec
    case 0xea: case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: // NOP
      return true;
    default:
      return false;
  }
}

// 読み命令の基本サイクル + ページ跨ぎペナルティ。
function read_cycles(mode: AddressingMode, page_crossed: boolean): number {
  let base = 2;
  switch (mode) {
    case Immediate: base = 2; break;
    case ZeroPage: base = 3; break;
    case ZeroPageX: case ZeroPageY: base = 4; break;
    case Absolute: base = 4; break;
    case AbsoluteX: case AbsoluteY: base = 4; break;
    case IndexedIndirect: base = 6; break;
    case IndirectIndexed: base = 5; break;
    default: base = 2; break;
  }
  const extra =
    page_crossed && (mode === AbsoluteX || mode === AbsoluteY || mode === IndirectIndexed);
  return base + (extra ? 1 : 0);
}

function logical_cycles(mode: AddressingMode): number {
  return read_cycles(mode, false);
}

function store_cycles(mode: AddressingMode): number {
  switch (mode) {
    case ZeroPage: return 3;
    case ZeroPageX: case ZeroPageY: return 4;
    case Absolute: return 4;
    case AbsoluteX: case AbsoluteY: return 5;
    case IndexedIndirect: return 6;
    case IndirectIndexed: return 6;
    default: return 3;
  }
}

function shift_cycles(mode: AddressingMode): number {
  switch (mode) {
    case ZeroPage: return 5;
    case ZeroPageX: return 6;
    case Absolute: return 6;
    case AbsoluteX: return 7;
    default: return 2;
  }
}

function rmw_illegal_cycles(mode: AddressingMode): number {
  switch (mode) {
    case Absolute: return 6;
    case AbsoluteX: return 7;
    case AbsoluteY: return 7;
    case ZeroPage: return 5;
    case ZeroPageX: return 6;
    case IndexedIndirect: return 8;
    case IndirectIndexed: return 8;
    default: return 0;
  }
}

// 6502 プロセッサ。
export class Cpu {
  // レジスタ
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  pc = 0;
  p = FLAG_UNUSED | FLAG_INTERRUPT;

  // 累積サイクル数。
  cycles = 0;

  // 割り込みライン
  nmi = false;
  irq = false;

  // 直前の operand_address / operand がページを跨いだか（C++ の pair.second）。
  page_crossed = false;

  // 前命令末尾の IRQ ポール成功をラッチする。
  private pending_irq_ = false;
  // CLI/SEI/PLP の I 遅延書き。
  private i_write_late_ = false;
  // 末尾 IRQ ポールで使う I 値。
  private poll_i_ = false;
  private poll_i_is_set_ = false;
  // 直前命令の末尾 IRQ ポール抑制（非ページ跨ぎ分岐成立）。
  private suppress_post_poll_ = false;
  // 次 step の戻りサイクルに上乗せされる追加サイクル（OAM DMA）。
  private extra_cycles_ = 0;

  // ---- フラグ操作 ----
  get_flag(flag: number): boolean {
    return (this.p & flag) !== 0;
  }

  set_flag(flag: number, value: boolean): void {
    if (value) {
      this.p = (this.p | flag) & 0xff;
    } else {
      this.p = this.p & ~flag & 0xff;
    }
  }

  private set_zn(value: number): void {
    this.set_flag(FLAG_ZERO, value === 0);
    this.set_flag(FLAG_NEGATIVE, (value & 0x80) !== 0);
  }

  // ---- メモリ／スタック ----
  private read(bus: Bus, addr: number): number {
    return bus.read(addr);
  }

  private write(bus: Bus, addr: number, value: number): void {
    this.extra_cycles_ += bus.write(addr, value);
  }

  private rmw_read(bus: Bus, addr: number): number {
    const value = this.read(bus, addr);
    this.write(bus, addr, value); // ダミー書き込み（open-bus 先で副作用を持つ）
    return value;
  }

  private read16(bus: Bus, addr: number): number {
    const lo = this.read(bus, addr);
    const hi = this.read(bus, (addr + 1) & 0xffff);
    return ((hi << 8) | lo) & 0xffff;
  }

  push(bus: Bus, value: number): void {
    this.write(bus, (0x100 | this.sp) & 0xffff, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  pop(bus: Bus): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(bus, (0x100 | this.sp) & 0xffff);
  }

  push16(bus: Bus, value: number): void {
    this.push(bus, (value >> 8) & 0xff);
    this.push(bus, value & 0xff);
  }

  pop16(bus: Bus): number {
    const lo = this.pop(bus);
    const hi = this.pop(bus);
    return ((hi << 8) | lo) & 0xffff;
  }

  // ---- リセット／割り込み ----
  reset(bus: Bus): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xfd;
    this.p = FLAG_UNUSED | FLAG_INTERRUPT;
    this.pc = this.read16(bus, 0xfffc);
    this.cycles = 0;
  }

  soft_reset(bus: Bus): void {
    this.sp = (this.sp - 3) & 0xff;
    this.set_flag(FLAG_INTERRUPT, true);
    this.pc = this.read16(bus, 0xfffc);
  }

  trigger_nmi(): void {
    this.nmi = true;
  }

  trigger_irq(): void {
    this.irq = true;
  }

  private handle_nmi(bus: Bus): void {
    this.push16(bus, this.pc);
    this.push(bus, this.p);
    this.vector(bus, 0xfffa);
  }

  private handle_irq(bus: Bus): void {
    this.push16(bus, this.pc);
    this.push(bus, this.p);
    this.vector(bus, 0xfffe);
  }

  private vector(bus: Bus, addr: number): void {
    if (this.nmi) {
      this.nmi = false;
      addr = 0xfffa; // NMI ハイジャック
    }
    this.set_flag(FLAG_INTERRUPT, true);
    this.pc = this.read16(bus, addr);
  }

  // 直前に完了した命令の IRQ ラインをサンプリングする（Nes::step が PPU/APU を
  // 進めた後に呼ぶ）。
  poll_irq(): void {
    if (!this.poll_i_is_set_) {
      return;
    }
    this.poll_i_is_set_ = false;
    if (this.irq && !this.poll_i_) {
      this.pending_irq_ = true;
    }
  }

  // ---- セーブステート ----
  save_state(w: StateWriter): void {
    w.u8(this.a);
    w.u8(this.x);
    w.u8(this.y);
    w.u8(this.sp);
    w.u16(this.pc);
    w.u8(this.p);
    w.i64(this.cycles);
    w.boolean(this.nmi);
    w.boolean(this.irq);
    w.boolean(this.pending_irq_);
    w.boolean(this.i_write_late_);
    w.boolean(this.poll_i_);
    w.boolean(this.poll_i_is_set_);
    w.boolean(this.suppress_post_poll_);
    w.i32(this.extra_cycles_);
  }

  load_state(r: StateReader): void {
    this.a = r.u8();
    this.x = r.u8();
    this.y = r.u8();
    this.sp = r.u8();
    this.pc = r.u16();
    this.p = r.u8();
    this.cycles = r.i64();
    this.nmi = r.boolean();
    this.irq = r.boolean();
    this.pending_irq_ = r.boolean();
    this.i_write_late_ = r.boolean();
    this.poll_i_ = r.boolean();
    this.poll_i_is_set_ = r.boolean();
    this.suppress_post_poll_ = r.boolean();
    this.extra_cycles_ = r.i32();
  }

  // ---- メイン実行 ----
  // 1 命令実行し、消費サイクル数を返す。
  step(bus: Bus): number {
    if (this.nmi) {
      this.handle_nmi(bus);
      this.nmi = false;
      this.poll_i_is_set_ = false;
      return 7;
    }

    // 前命令ポールで保留になった IRQ をここで処理（次オペコード取得前）。
    if (this.pending_irq_) {
      this.pending_irq_ = false;
      this.handle_irq(bus);
      this.poll_i_is_set_ = false;
      return 7;
    }

    // 命令前の I をスナップショット（CLI/SEI/PLP の遅延ポール用）。
    const pre_i = this.get_flag(FLAG_INTERRUPT);

    const opcode = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;

    let cyc = this.execute_instruction(bus, opcode);
    cyc += this.extra_cycles_;
    this.extra_cycles_ = 0;
    this.cycles += cyc;

    // 末尾 IRQ ポールが使う I 値を確定する。
    this.poll_i_ = this.get_flag(FLAG_INTERRUPT);
    if (this.i_write_late_) {
      this.poll_i_ = pre_i;
      this.i_write_late_ = false;
    }
    this.poll_i_is_set_ = !this.suppress_post_poll_;
    this.suppress_post_poll_ = false;

    return cyc;
  }

  private execute_instruction(bus: Bus, opcode: number): number {
    if (needs_dummy_fetch(opcode)) {
      this.read(bus, this.pc);
    }

    switch (opcode) {
      // LDA
      case 0xa9: return this.lda(bus, Immediate);
      case 0xa5: return this.lda(bus, ZeroPage);
      case 0xb5: return this.lda(bus, ZeroPageX);
      case 0xad: return this.lda(bus, Absolute);
      case 0xbd: return this.lda(bus, AbsoluteX);
      case 0xb9: return this.lda(bus, AbsoluteY);
      case 0xa1: return this.lda(bus, IndexedIndirect);
      case 0xb1: return this.lda(bus, IndirectIndexed);
      // LDX
      case 0xa2: return this.ldx(bus, Immediate);
      case 0xa6: return this.ldx(bus, ZeroPage);
      case 0xb6: return this.ldx(bus, ZeroPageY);
      case 0xae: return this.ldx(bus, Absolute);
      case 0xbe: return this.ldx(bus, AbsoluteY);
      // LDY
      case 0xa0: return this.ldy(bus, Immediate);
      case 0xa4: return this.ldy(bus, ZeroPage);
      case 0xb4: return this.ldy(bus, ZeroPageX);
      case 0xac: return this.ldy(bus, Absolute);
      case 0xbc: return this.ldy(bus, AbsoluteX);
      // STA
      case 0x85: return this.sta(bus, ZeroPage);
      case 0x95: return this.sta(bus, ZeroPageX);
      case 0x8d: return this.sta(bus, Absolute);
      case 0x9d: return this.sta(bus, AbsoluteX);
      case 0x99: return this.sta(bus, AbsoluteY);
      case 0x81: return this.sta(bus, IndexedIndirect);
      case 0x91: return this.sta(bus, IndirectIndexed);
      // STX
      case 0x86: return this.stx(bus, ZeroPage);
      case 0x96: return this.stx(bus, ZeroPageY);
      case 0x8e: return this.stx(bus, Absolute);
      // STY
      case 0x84: return this.sty(bus, ZeroPage);
      case 0x94: return this.sty(bus, ZeroPageX);
      case 0x8c: return this.sty(bus, Absolute);
      // ADC
      case 0x69: return this.adc(bus, Immediate);
      case 0x65: return this.adc(bus, ZeroPage);
      case 0x75: return this.adc(bus, ZeroPageX);
      case 0x6d: return this.adc(bus, Absolute);
      case 0x7d: return this.adc(bus, AbsoluteX);
      case 0x79: return this.adc(bus, AbsoluteY);
      case 0x61: return this.adc(bus, IndexedIndirect);
      case 0x71: return this.adc(bus, IndirectIndexed);
      // SBC (+EB illegal alias)
      case 0xe9: case 0xeb: return this.sbc(bus, Immediate);
      case 0xe5: return this.sbc(bus, ZeroPage);
      case 0xf5: return this.sbc(bus, ZeroPageX);
      case 0xed: return this.sbc(bus, Absolute);
      case 0xfd: return this.sbc(bus, AbsoluteX);
      case 0xf9: return this.sbc(bus, AbsoluteY);
      case 0xe1: return this.sbc(bus, IndexedIndirect);
      case 0xf1: return this.sbc(bus, IndirectIndexed);
      // CMP
      case 0xc9: return this.cmp(bus, Immediate);
      case 0xc5: return this.cmp(bus, ZeroPage);
      case 0xd5: return this.cmp(bus, ZeroPageX);
      case 0xcd: return this.cmp(bus, Absolute);
      case 0xdd: return this.cmp(bus, AbsoluteX);
      case 0xd9: return this.cmp(bus, AbsoluteY);
      case 0xc1: return this.cmp(bus, IndexedIndirect);
      case 0xd1: return this.cmp(bus, IndirectIndexed);
      // CPX
      case 0xe0: return this.cpx(bus, Immediate);
      case 0xe4: return this.cpx(bus, ZeroPage);
      case 0xec: return this.cpx(bus, Absolute);
      // CPY
      case 0xc0: return this.cpy(bus, Immediate);
      case 0xc4: return this.cpy(bus, ZeroPage);
      case 0xcc: return this.cpy(bus, Absolute);
      // 転送
      case 0xaa: return this.tax();
      case 0x8a: return this.txa();
      case 0xa8: return this.tay();
      case 0x98: return this.tya();
      case 0x9a: return this.txs();
      case 0xba: return this.tsx();
      // フラグ
      case 0x18: return this.flag_op(FLAG_CARRY, false, false);
      case 0x38: return this.flag_op(FLAG_CARRY, true, false);
      case 0x58: return this.flag_op(FLAG_INTERRUPT, false, true);
      case 0x78: return this.flag_op(FLAG_INTERRUPT, true, true);
      case 0xb8: return this.flag_op(FLAG_OVERFLOW, false, false);
      case 0xd8: return this.flag_op(FLAG_DECIMAL, false, false);
      case 0xf8: return this.flag_op(FLAG_DECIMAL, true, false);
      // スタック
      case 0x48: return this.pha(bus);
      case 0x68: return this.pla(bus);
      case 0x08: return this.php(bus);
      case 0x28: return this.plp(bus);
      // 分岐
      case 0x10: return this.branch(bus, !this.get_flag(FLAG_NEGATIVE));
      case 0x30: return this.branch(bus, this.get_flag(FLAG_NEGATIVE));
      case 0x50: return this.branch(bus, !this.get_flag(FLAG_OVERFLOW));
      case 0x70: return this.branch(bus, this.get_flag(FLAG_OVERFLOW));
      case 0x90: return this.branch(bus, !this.get_flag(FLAG_CARRY));
      case 0xb0: return this.branch(bus, this.get_flag(FLAG_CARRY));
      case 0xd0: return this.branch(bus, !this.get_flag(FLAG_ZERO));
      case 0xf0: return this.branch(bus, this.get_flag(FLAG_ZERO));
      // ジャンプ／サブルーチン
      case 0x4c: return this.jmp_absolute(bus);
      case 0x6c: return this.jmp_indirect(bus);
      case 0x20: return this.jsr(bus);
      case 0x60: return this.rts(bus);
      case 0x40: return this.rti(bus);
      // AND
      case 0x29: return this.and_op(bus, Immediate);
      case 0x25: return this.and_op(bus, ZeroPage);
      case 0x35: return this.and_op(bus, ZeroPageX);
      case 0x2d: return this.and_op(bus, Absolute);
      case 0x3d: return this.and_op(bus, AbsoluteX);
      case 0x39: return this.and_op(bus, AbsoluteY);
      case 0x21: return this.and_op(bus, IndexedIndirect);
      case 0x31: return this.and_op(bus, IndirectIndexed);
      // ORA
      case 0x09: return this.ora(bus, Immediate);
      case 0x05: return this.ora(bus, ZeroPage);
      case 0x15: return this.ora(bus, ZeroPageX);
      case 0x0d: return this.ora(bus, Absolute);
      case 0x1d: return this.ora(bus, AbsoluteX);
      case 0x19: return this.ora(bus, AbsoluteY);
      case 0x01: return this.ora(bus, IndexedIndirect);
      case 0x11: return this.ora(bus, IndirectIndexed);
      // EOR
      case 0x49: return this.eor(bus, Immediate);
      case 0x45: return this.eor(bus, ZeroPage);
      case 0x55: return this.eor(bus, ZeroPageX);
      case 0x4d: return this.eor(bus, Absolute);
      case 0x5d: return this.eor(bus, AbsoluteX);
      case 0x59: return this.eor(bus, AbsoluteY);
      case 0x41: return this.eor(bus, IndexedIndirect);
      case 0x51: return this.eor(bus, IndirectIndexed);
      // ASL
      case 0x0a: return this.asl_accumulator();
      case 0x06: return this.asl(bus, ZeroPage);
      case 0x16: return this.asl(bus, ZeroPageX);
      case 0x0e: return this.asl(bus, Absolute);
      case 0x1e: return this.asl(bus, AbsoluteX);
      // LSR
      case 0x4a: return this.lsr_accumulator();
      case 0x46: return this.lsr(bus, ZeroPage);
      case 0x56: return this.lsr(bus, ZeroPageX);
      case 0x4e: return this.lsr(bus, Absolute);
      case 0x5e: return this.lsr(bus, AbsoluteX);
      // ROL
      case 0x2a: return this.rol_accumulator();
      case 0x26: return this.rol(bus, ZeroPage);
      case 0x36: return this.rol(bus, ZeroPageX);
      case 0x2e: return this.rol(bus, Absolute);
      case 0x3e: return this.rol(bus, AbsoluteX);
      // ROR
      case 0x6a: return this.ror_accumulator();
      case 0x66: return this.ror(bus, ZeroPage);
      case 0x76: return this.ror(bus, ZeroPageX);
      case 0x6e: return this.ror(bus, Absolute);
      case 0x7e: return this.ror(bus, AbsoluteX);
      // INC
      case 0xe6: return this.inc(bus, ZeroPage);
      case 0xf6: return this.inc(bus, ZeroPageX);
      case 0xee: return this.inc(bus, Absolute);
      case 0xfe: return this.inc(bus, AbsoluteX);
      // DEC
      case 0xc6: return this.dec(bus, ZeroPage);
      case 0xd6: return this.dec(bus, ZeroPageX);
      case 0xce: return this.dec(bus, Absolute);
      case 0xde: return this.dec(bus, AbsoluteX);
      // INX/DEX/INY/DEY
      case 0xe8: return this.inx();
      case 0xca: return this.dex();
      case 0xc8: return this.iny();
      case 0x88: return this.dey();
      // BIT
      case 0x24: return this.bit(bus, ZeroPage);
      case 0x2c: return this.bit(bus, Absolute);
      // BRK / NOP
      case 0x00: return this.brk(bus);
      case 0xea: return 2;
      // 非公式 NOP（implied、2 サイクル）
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: return 2;
      // 非公式 NOP #imm（2）
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2:
        return this.nop_read(bus, Immediate);
      // 非公式 NOP zp（3）
      case 0x04: case 0x44: case 0x64: return this.nop_read(bus, ZeroPage);
      // 非公式 NOP zp,X（4）
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:
        return this.nop_read(bus, ZeroPageX);
      // 非公式 NOP abs（4）
      case 0x0c: return this.nop_read(bus, Absolute);
      // 非公式 NOP abs,X（4 + ページ跨ぎ）
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:
        return this.nop_read(bus, AbsoluteX);
      // LAX
      case 0xaf: return this.lax(bus, Absolute);
      case 0xbf: return this.lax(bus, AbsoluteY);
      case 0xa7: return this.lax(bus, ZeroPage);
      case 0xb7: return this.lax(bus, ZeroPageY);
      case 0xa3: return this.lax(bus, IndexedIndirect);
      case 0xb3: return this.lax(bus, IndirectIndexed);
      // SAX
      case 0x8f: return this.sax(bus, Absolute);
      case 0x87: return this.sax(bus, ZeroPage);
      case 0x97: return this.sax(bus, ZeroPageY);
      case 0x83: return this.sax(bus, IndexedIndirect);
      // AAC/ANC
      case 0x0b: case 0x2b: return this.aac(bus);
      // ASR/ALR
      case 0x4b: return this.asr(bus);
      // ARR
      case 0x6b: return this.arr(bus);
      // ATX/LXA
      case 0xab: return this.atx(bus);
      // AXS/SBX
      case 0xcb: return this.axs(bus);
      // DCP
      case 0xcf: return this.dcp(bus, Absolute);
      case 0xdf: return this.dcp(bus, AbsoluteX);
      case 0xdb: return this.dcp(bus, AbsoluteY);
      case 0xc7: return this.dcp(bus, ZeroPage);
      case 0xd7: return this.dcp(bus, ZeroPageX);
      case 0xc3: return this.dcp(bus, IndexedIndirect);
      case 0xd3: return this.dcp(bus, IndirectIndexed);
      // ISB/ISC
      case 0xef: return this.isb(bus, Absolute);
      case 0xff: return this.isb(bus, AbsoluteX);
      case 0xfb: return this.isb(bus, AbsoluteY);
      case 0xe7: return this.isb(bus, ZeroPage);
      case 0xf7: return this.isb(bus, ZeroPageX);
      case 0xe3: return this.isb(bus, IndexedIndirect);
      case 0xf3: return this.isb(bus, IndirectIndexed);
      // SLO
      case 0x0f: return this.slo(bus, Absolute);
      case 0x1f: return this.slo(bus, AbsoluteX);
      case 0x1b: return this.slo(bus, AbsoluteY);
      case 0x07: return this.slo(bus, ZeroPage);
      case 0x17: return this.slo(bus, ZeroPageX);
      case 0x03: return this.slo(bus, IndexedIndirect);
      case 0x13: return this.slo(bus, IndirectIndexed);
      // RLA
      case 0x2f: return this.rla(bus, Absolute);
      case 0x3f: return this.rla(bus, AbsoluteX);
      case 0x3b: return this.rla(bus, AbsoluteY);
      case 0x27: return this.rla(bus, ZeroPage);
      case 0x37: return this.rla(bus, ZeroPageX);
      case 0x23: return this.rla(bus, IndexedIndirect);
      case 0x33: return this.rla(bus, IndirectIndexed);
      // SRE
      case 0x4f: return this.sre(bus, Absolute);
      case 0x5f: return this.sre(bus, AbsoluteX);
      case 0x5b: return this.sre(bus, AbsoluteY);
      case 0x47: return this.sre(bus, ZeroPage);
      case 0x57: return this.sre(bus, ZeroPageX);
      case 0x43: return this.sre(bus, IndexedIndirect);
      case 0x53: return this.sre(bus, IndirectIndexed);
      // RRA
      case 0x6f: return this.rra(bus, Absolute);
      case 0x7f: return this.rra(bus, AbsoluteX);
      case 0x7b: return this.rra(bus, AbsoluteY);
      case 0x67: return this.rra(bus, ZeroPage);
      case 0x77: return this.rra(bus, ZeroPageX);
      case 0x63: return this.rra(bus, IndexedIndirect);
      case 0x73: return this.rra(bus, IndirectIndexed);
      // 未割り当て（KIL 等）: 2 サイクル
      default: return 2;
    }
  }

  // ---- アドレッシング ----
  // オペランドアドレスを解決する。ページ跨ぎは this.page_crossed に置く。
  operand_address(bus: Bus, mode: AddressingMode): number {
    this.page_crossed = false;
    switch (mode) {
      case Implied:
      case Accumulator:
        return 0;
      case Immediate: {
        const addr = this.pc;
        this.pc = (this.pc + 1) & 0xffff;
        return addr;
      }
      case ZeroPage: {
        const addr = this.read(bus, this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        return addr;
      }
      case ZeroPageX: {
        const addr = (this.read(bus, this.pc) + this.x) & 0xff;
        this.pc = (this.pc + 1) & 0xffff;
        return addr;
      }
      case ZeroPageY: {
        const addr = (this.read(bus, this.pc) + this.y) & 0xff;
        this.pc = (this.pc + 1) & 0xffff;
        return addr;
      }
      case Relative: {
        const raw = this.read(bus, this.pc);
        const offset = raw < 0x80 ? raw : raw - 0x100; // int8
        this.pc = (this.pc + 1) & 0xffff;
        const addr = (this.pc + offset) & 0xffff;
        this.page_crossed = (this.pc & 0xff00) !== (addr & 0xff00);
        return addr;
      }
      case Absolute: {
        const addr = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        return addr;
      }
      case AbsoluteX: {
        const base = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        const addr = (base + this.x) & 0xffff;
        const page_crossed = (base & 0xff00) !== (addr & 0xff00);
        if (page_crossed) {
          this.read(bus, (base & 0xff00) | (addr & 0xff));
        }
        this.page_crossed = page_crossed;
        return addr;
      }
      case AbsoluteY: {
        const base = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        const addr = (base + this.y) & 0xffff;
        const page_crossed = (base & 0xff00) !== (addr & 0xff00);
        if (page_crossed) {
          this.read(bus, (base & 0xff00) | (addr & 0xff));
        }
        this.page_crossed = page_crossed;
        return addr;
      }
      case Indirect: {
        // JMP 専用。ページ境界バグあり。
        const ptr = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        if ((ptr & 0xff) === 0xff) {
          const lo = this.read(bus, ptr);
          const hi = this.read(bus, ptr & 0xff00);
          return ((hi << 8) | lo) & 0xffff;
        }
        return this.read16(bus, ptr);
      }
      case IndexedIndirect: {
        const base = this.read(bus, this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        const ptr = (base + this.x) & 0xff;
        const lo = this.read(bus, ptr);
        const hi = this.read(bus, (ptr + 1) & 0xff);
        return ((hi << 8) | lo) & 0xffff;
      }
      case IndirectIndexed: {
        const base = this.read(bus, this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        const lo = this.read(bus, base);
        const hi = this.read(bus, (base + 1) & 0xff);
        const base_addr = ((hi << 8) | lo) & 0xffff;
        const addr = (base_addr + this.y) & 0xffff;
        const page_crossed = (base_addr & 0xff00) !== (addr & 0xff00);
        if (page_crossed) {
          this.read(bus, (base_addr & 0xff00) | (addr & 0xff));
        }
        this.page_crossed = page_crossed;
        return addr;
      }
      default:
        return 0;
    }
  }

  // オペランド値を読む。ページ跨ぎは this.page_crossed に置く。
  private operand(bus: Bus, mode: AddressingMode): number {
    if (mode === Accumulator) {
      this.page_crossed = false;
      return this.a;
    }
    const addr = this.operand_address(bus, mode);
    if (mode === Immediate) {
      this.page_crossed = false;
    }
    return this.read(bus, addr);
  }

  private write_address(bus: Bus, mode: AddressingMode): number {
    switch (mode) {
      case AbsoluteX: {
        const base = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        return this.indexed_write_addr(bus, base, this.x);
      }
      case AbsoluteY: {
        const base = this.read16(bus, this.pc);
        this.pc = (this.pc + 2) & 0xffff;
        return this.indexed_write_addr(bus, base, this.y);
      }
      case IndirectIndexed: {
        const base = this.read(bus, this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        const lo = this.read(bus, base);
        const hi = this.read(bus, (base + 1) & 0xff);
        return this.indexed_write_addr(bus, ((hi << 8) | lo) & 0xffff, this.y);
      }
      default:
        return this.operand_address(bus, mode);
    }
  }

  private indexed_write_addr(bus: Bus, base: number, idx: number): number {
    const addr = (base + idx) & 0xffff;
    this.read(bus, (base & 0xff00) | (addr & 0xff)); // 未補正アドレスへのダミー読み
    return addr;
  }

  // ---- 命令（公式）----
  private lda(bus: Bus, mode: AddressingMode): number {
    this.a = this.operand(bus, mode);
    this.set_zn(this.a);
    return read_cycles(mode, this.page_crossed);
  }

  private ldx(bus: Bus, mode: AddressingMode): number {
    this.x = this.operand(bus, mode);
    this.set_zn(this.x);
    return read_cycles(mode, this.page_crossed);
  }

  private ldy(bus: Bus, mode: AddressingMode): number {
    this.y = this.operand(bus, mode);
    this.set_zn(this.y);
    return read_cycles(mode, this.page_crossed);
  }

  private sta(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    this.write(bus, addr, this.a);
    return store_cycles(mode);
  }

  private stx(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    this.write(bus, addr, this.x);
    return store_cycles(mode);
  }

  private sty(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    this.write(bus, addr, this.y);
    return store_cycles(mode);
  }

  private adc(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    const carry = this.get_flag(FLAG_CARRY) ? 1 : 0;
    const result = this.a + value + carry;
    this.set_flag(FLAG_CARRY, result > 0xff);
    const r8 = result & 0xff;
    this.set_flag(FLAG_OVERFLOW, ((this.a ^ r8) & (value ^ r8) & 0x80) !== 0);
    this.a = r8;
    this.set_zn(this.a);
    return read_cycles(mode, page_crossed);
  }

  private sbc(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    const carry = this.get_flag(FLAG_CARRY) ? 1 : 0;
    const result = (this.a - value - (1 - carry)) & 0xffff;
    this.set_flag(FLAG_CARRY, result <= 0xff);
    const r8 = result & 0xff;
    this.set_flag(FLAG_OVERFLOW, ((this.a ^ r8) & ((this.a ^ value) & 0x80)) !== 0);
    this.a = r8;
    this.set_zn(this.a);
    return read_cycles(mode, page_crossed);
  }

  private cmp(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    const result = (this.a - value) & 0xff;
    this.set_flag(FLAG_CARRY, this.a >= value);
    this.set_zn(result);
    return read_cycles(mode, page_crossed);
  }

  private cpx(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    const result = (this.x - value) & 0xff;
    this.set_flag(FLAG_CARRY, this.x >= value);
    this.set_zn(result);
    return read_cycles(mode, page_crossed);
  }

  private cpy(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    const result = (this.y - value) & 0xff;
    this.set_flag(FLAG_CARRY, this.y >= value);
    this.set_zn(result);
    return read_cycles(mode, page_crossed);
  }

  private tax(): number {
    this.x = this.a;
    this.set_zn(this.x);
    return 2;
  }
  private txa(): number {
    this.a = this.x;
    this.set_zn(this.a);
    return 2;
  }
  private tay(): number {
    this.y = this.a;
    this.set_zn(this.y);
    return 2;
  }
  private tya(): number {
    this.a = this.y;
    this.set_zn(this.a);
    return 2;
  }
  private txs(): number {
    this.sp = this.x;
    return 2;
  }
  private tsx(): number {
    this.x = this.sp;
    this.set_zn(this.x);
    return 2;
  }

  private flag_op(flag: number, value: boolean, is_i: boolean): number {
    this.set_flag(flag, value);
    if (is_i) {
      this.i_write_late_ = true;
    }
    return 2;
  }

  private pha(bus: Bus): number {
    this.push(bus, this.a);
    return 3;
  }

  private pla(bus: Bus): number {
    this.a = this.pop(bus);
    this.set_zn(this.a);
    return 4;
  }

  private php(bus: Bus): number {
    this.push(bus, (this.p | FLAG_BREAK) & 0xff);
    return 3;
  }

  private plp(bus: Bus): number {
    this.p = this.pop(bus);
    this.p = (this.p | FLAG_UNUSED) & 0xff;
    this.p = this.p & ~FLAG_BREAK & 0xff;
    this.i_write_late_ = true; // PLP の I 書き込みも IRQ ポールサイクルに重なる
    return 4;
  }

  private branch(bus: Bus, condition: boolean): number {
    const raw = this.read(bus, this.pc);
    const offset = raw < 0x80 ? raw : raw - 0x100; // int8
    this.pc = (this.pc + 1) & 0xffff;

    if (condition) {
      const old_pc = this.pc;
      const new_pc = (this.pc + offset) & 0xffff;
      this.pc = new_pc;
      if ((old_pc & 0xff00) !== (new_pc & 0xff00)) {
        return 4;
      }
      // 非ページ跨ぎの成立分岐は cycle-2 IRQ ポールを落とす。
      this.suppress_post_poll_ = true;
      return 3;
    }
    return 2;
  }

  private jmp_absolute(bus: Bus): number {
    const low = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const high = this.read(bus, this.pc);
    this.pc = ((high << 8) | low) & 0xffff;
    return 3;
  }

  private jmp_indirect(bus: Bus): number {
    const low = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const high = this.read(bus, this.pc);
    const indirect = ((high << 8) | low) & 0xffff;

    const actual_low = this.read(bus, indirect);
    const actual_high =
      (indirect & 0xff) === 0xff
        ? this.read(bus, indirect & 0xff00) // バグ: 同一ページ
        : this.read(bus, (indirect + 1) & 0xffff);
    this.pc = ((actual_high << 8) | actual_low) & 0xffff;
    return 5;
  }

  private jsr(bus: Bus): number {
    const low = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const high = this.read(bus, this.pc);
    const return_addr = this.pc;
    this.push(bus, (return_addr >> 8) & 0xff);
    this.push(bus, return_addr & 0xff);
    this.pc = ((high << 8) | low) & 0xffff;
    return 6;
  }

  private rts(bus: Bus): number {
    this.pc = (this.pop16(bus) + 1) & 0xffff;
    return 6;
  }

  private rti(bus: Bus): number {
    this.p = this.pop(bus);
    this.p = (this.p | FLAG_UNUSED) & 0xff;
    this.p = this.p & ~FLAG_BREAK & 0xff;
    this.pc = this.pop16(bus);
    return 6;
  }

  private and_op(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    this.a = this.a & value & 0xff;
    this.set_zn(this.a);
    return read_cycles(mode, page_crossed);
  }

  private ora(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    this.a = (this.a | value) & 0xff;
    this.set_zn(this.a);
    return read_cycles(mode, page_crossed);
  }

  private eor(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    this.a = (this.a ^ value) & 0xff;
    this.set_zn(this.a);
    return read_cycles(mode, page_crossed);
  }

  private asl_accumulator(): number {
    this.set_flag(FLAG_CARRY, (this.a & 0x80) !== 0);
    this.a = (this.a << 1) & 0xff;
    this.set_zn(this.a);
    return 2;
  }

  private asl(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    this.set_flag(FLAG_CARRY, (value & 0x80) !== 0);
    const result = (value << 1) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private lsr_accumulator(): number {
    this.set_flag(FLAG_CARRY, (this.a & 0x01) !== 0);
    this.a = (this.a >> 1) & 0xff;
    this.set_zn(this.a);
    return 2;
  }

  private lsr(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    this.set_flag(FLAG_CARRY, (value & 0x01) !== 0);
    const result = (value >> 1) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private rol_accumulator(): number {
    const old_carry = this.get_flag(FLAG_CARRY) ? 1 : 0;
    this.set_flag(FLAG_CARRY, (this.a & 0x80) !== 0);
    this.a = ((this.a << 1) | old_carry) & 0xff;
    this.set_zn(this.a);
    return 2;
  }

  private rol(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    const old_carry = this.get_flag(FLAG_CARRY) ? 1 : 0;
    this.set_flag(FLAG_CARRY, (value & 0x80) !== 0);
    const result = ((value << 1) | old_carry) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private ror_accumulator(): number {
    const old_carry = this.get_flag(FLAG_CARRY) ? 0x80 : 0;
    this.set_flag(FLAG_CARRY, (this.a & 0x01) !== 0);
    this.a = ((this.a >> 1) | old_carry) & 0xff;
    this.set_zn(this.a);
    return 2;
  }

  private ror(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    const old_carry = this.get_flag(FLAG_CARRY) ? 0x80 : 0;
    this.set_flag(FLAG_CARRY, (value & 0x01) !== 0);
    const result = ((value >> 1) | old_carry) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private inc(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    const result = (value + 1) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private dec(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    const value = this.rmw_read(bus, addr);
    const result = (value - 1) & 0xff;
    this.set_zn(result);
    this.write(bus, addr, result);
    return shift_cycles(mode);
  }

  private inx(): number {
    this.x = (this.x + 1) & 0xff;
    this.set_zn(this.x);
    return 2;
  }
  private dex(): number {
    this.x = (this.x - 1) & 0xff;
    this.set_zn(this.x);
    return 2;
  }
  private iny(): number {
    this.y = (this.y + 1) & 0xff;
    this.set_zn(this.y);
    return 2;
  }
  private dey(): number {
    this.y = (this.y - 1) & 0xff;
    this.set_zn(this.y);
    return 2;
  }

  private bit(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const result = this.a & value & 0xff;
    this.set_flag(FLAG_ZERO, result === 0);
    this.set_flag(FLAG_NEGATIVE, (value & 0x80) !== 0);
    this.set_flag(FLAG_OVERFLOW, (value & 0x40) !== 0);
    return logical_cycles(mode);
  }

  private brk(bus: Bus): number {
    this.pc = (this.pc + 1) & 0xffff; // BRK は実質 2 バイト
    this.push16(bus, this.pc);
    this.push(bus, (this.p | FLAG_BREAK) & 0xff);
    this.vector(bus, 0xfffe);
    return 7;
  }

  private nop_read(bus: Bus, mode: AddressingMode): number {
    this.operand(bus, mode);
    return read_cycles(mode, this.page_crossed);
  }

  // ---- 命令（非公式）----
  private lax(bus: Bus, mode: AddressingMode): number {
    const value = this.operand(bus, mode);
    const page_crossed = this.page_crossed;
    this.a = value;
    this.x = value;
    this.set_zn(value);
    let cyc = 0;
    switch (mode) {
      case Absolute: cyc = 4; break;
      case AbsoluteY: cyc = 4; break;
      case ZeroPage: cyc = 3; break;
      case ZeroPageY: cyc = 4; break;
      case IndexedIndirect: cyc = 6; break;
      case IndirectIndexed: cyc = 5; break;
      default: cyc = 0; break;
    }
    if (page_crossed && (mode === AbsoluteY || mode === IndirectIndexed)) {
      cyc += 1;
    }
    return cyc;
  }

  private sax(bus: Bus, mode: AddressingMode): number {
    const addr = this.operand_address(bus, mode);
    this.write(bus, addr, this.a & this.x & 0xff);
    switch (mode) {
      case Absolute: return 4;
      case ZeroPage: return 3;
      case ZeroPageY: return 4;
      case IndexedIndirect: return 6;
      default: return 0;
    }
  }

  private dcp(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    value = (value - 1) & 0xff;
    this.write(bus, addr, value);
    const result = (this.a - value) & 0xffff;
    this.set_flag(FLAG_CARRY, result < 0x100);
    this.set_zn(result & 0xff);
    return rmw_illegal_cycles(mode);
  }

  private isb(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    value = (value + 1) & 0xff;
    this.write(bus, addr, value);
    this.perform_sbc(value);
    return rmw_illegal_cycles(mode);
  }

  private slo(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    this.set_flag(FLAG_CARRY, (value & 0x80) !== 0);
    value = (value << 1) & 0xff;
    this.write(bus, addr, value);
    this.a = (this.a | value) & 0xff;
    this.set_zn(this.a);
    return rmw_illegal_cycles(mode);
  }

  private rla(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    const new_carry = (value & 0x80) !== 0;
    const carry_bit = this.get_flag(FLAG_CARRY) ? 1 : 0;
    value = ((value << 1) | carry_bit) & 0xff;
    this.set_flag(FLAG_CARRY, new_carry);
    this.write(bus, addr, value);
    this.a = this.a & value & 0xff;
    this.set_zn(this.a);
    return rmw_illegal_cycles(mode);
  }

  private sre(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    this.set_flag(FLAG_CARRY, (value & 0x01) !== 0);
    value = (value >> 1) & 0xff;
    this.write(bus, addr, value);
    this.a = (this.a ^ value) & 0xff;
    this.set_zn(this.a);
    return rmw_illegal_cycles(mode);
  }

  private rra(bus: Bus, mode: AddressingMode): number {
    const addr = this.write_address(bus, mode);
    let value = this.rmw_read(bus, addr);
    const new_carry = (value & 0x01) !== 0;
    const carry_bit = this.get_flag(FLAG_CARRY) ? 0x80 : 0;
    value = ((value >> 1) | carry_bit) & 0xff;
    this.set_flag(FLAG_CARRY, new_carry);
    this.write(bus, addr, value);
    this.perform_adc(value);
    return rmw_illegal_cycles(mode);
  }

  private perform_sbc(value: number): void {
    this.perform_adc(~value & 0xff);
  }

  private perform_adc(value: number): void {
    const carry = this.get_flag(FLAG_CARRY) ? 1 : 0;
    const result = this.a + value + carry;
    const overflow = ((this.a ^ value) & 0x80) === 0 && ((this.a ^ (result & 0xff)) & 0x80) !== 0;
    this.set_flag(FLAG_OVERFLOW, overflow);
    this.set_flag(FLAG_CARRY, result > 0xff);
    this.a = result & 0xff;
    this.set_zn(this.a);
  }

  private aac(bus: Bus): number {
    const value = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.a = this.a & value & 0xff;
    this.set_zn(this.a);
    this.set_flag(FLAG_CARRY, (this.a & 0x80) !== 0);
    return 2;
  }

  private asr(bus: Bus): number {
    const value = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.a = this.a & value & 0xff;
    this.set_flag(FLAG_CARRY, (this.a & 0x01) !== 0);
    this.a = (this.a >> 1) & 0xff;
    this.set_zn(this.a);
    return 2;
  }

  private arr(bus: Bus): number {
    const value = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.a = this.a & value & 0xff;
    const new_carry = (this.a & 0x01) !== 0;
    const carry_bit = this.get_flag(FLAG_CARRY) ? 0x80 : 0;
    this.a = ((this.a >> 1) | carry_bit) & 0xff;
    this.set_flag(FLAG_CARRY, new_carry);
    this.set_zn(this.a);
    // V = bit6 XOR bit5, C = bit6
    this.set_flag(FLAG_OVERFLOW, (((this.a >> 6) & 1) ^ ((this.a >> 5) & 1)) !== 0);
    this.set_flag(FLAG_CARRY, (this.a & 0x40) !== 0);
    return 2;
  }

  private atx(bus: Bus): number {
    const value = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.a = value;
    this.x = value;
    this.set_zn(this.a);
    return 2;
  }

  private axs(bus: Bus): number {
    const value = this.read(bus, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const temp = this.a & this.x & 0xff;
    const result = (temp - value) & 0xffff;
    this.x = result & 0xff;
    this.set_flag(FLAG_CARRY, result < 0x100);
    this.set_zn(this.x);
    return 2;
  }
}
