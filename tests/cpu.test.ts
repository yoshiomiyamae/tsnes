// CPU ユニットテスト（移植元 cppnes `core/tests/cpu_test.cpp`）。
import { describe, expect, test } from "bun:test";
import { Bus } from "../src/core/bus.ts";
import {
  AddressingMode,
  Cpu,
  FLAG_CARRY,
  FLAG_INTERRUPT,
  FLAG_NEGATIVE,
  FLAG_OVERFLOW,
  FLAG_UNUSED,
  FLAG_ZERO,
} from "../src/core/cpu.ts";

const { Immediate, ZeroPage, ZeroPageX, AbsoluteY } = AddressingMode;

interface CpuBus {
  cpu: Cpu;
  bus: Bus;
}

// テスト用 CPU。リセットベクタを $0200 に設定（カートリッジ無し → high-mem）。
function create_test_cpu(): CpuBus {
  const s: CpuBus = { cpu: new Cpu(), bus: new Bus() };
  s.bus.write(0xfffc, 0x00);
  s.bus.write(0xfffd, 0x02);
  s.cpu.reset(s.bus);
  return s;
}

// $0200 にプログラムをロードし PC をそこへ向ける。
function setup_with_program(program: number[]): CpuBus {
  const s = create_test_cpu();
  const start = 0x0200;
  for (let i = 0; i < program.length; i++) {
    s.bus.write(start + i, program[i]!);
  }
  s.cpu.pc = start;
  return s;
}

describe("cpu", () => {
  test("reset clears registers", () => {
    const s = create_test_cpu();
    s.cpu.a = 0xff;
    s.cpu.x = 0xff;
    s.cpu.y = 0xff;
    s.cpu.sp = 0x00;
    s.cpu.p = 0xff;
    s.cpu.reset(s.bus);
    expect(s.cpu.a).toBe(0);
    expect(s.cpu.x).toBe(0);
    expect(s.cpu.y).toBe(0);
    expect(s.cpu.sp).toBe(0xfd);
    expect(s.cpu.p).toBe(FLAG_UNUSED | FLAG_INTERRUPT);
  });

  test("flag set/get/clear", () => {
    const { cpu } = create_test_cpu();
    cpu.set_flag(FLAG_CARRY, true);
    expect(cpu.get_flag(FLAG_CARRY)).toBe(true);
    cpu.set_flag(FLAG_ZERO, true);
    expect(cpu.get_flag(FLAG_ZERO)).toBe(true);
    cpu.set_flag(FLAG_CARRY, false);
    expect(cpu.get_flag(FLAG_CARRY)).toBe(false);
    cpu.p = 0;
    cpu.set_flag(FLAG_CARRY, true);
    cpu.set_flag(FLAG_NEGATIVE, true);
    expect(cpu.p).toBe(FLAG_CARRY | FLAG_NEGATIVE);
  });

  test("stack push/pop", () => {
    const s = create_test_cpu();
    const { cpu } = s;
    const initial_sp = cpu.sp;
    cpu.push(s.bus, 0x42);
    expect(cpu.sp).toBe(initial_sp - 1);
    expect(cpu.pop(s.bus)).toBe(0x42);
    expect(cpu.sp).toBe(initial_sp);
    cpu.push16(s.bus, 0x1234);
    expect(cpu.pop16(s.bus)).toBe(0x1234);
  });

  test("addressing modes", () => {
    const s = create_test_cpu();
    const { cpu } = s;
    s.bus.write(0x00, 0x10);
    s.bus.write(0x01, 0x20);
    s.bus.write(0x10, 0x30);
    s.bus.write(0x1000, 0x40);
    s.bus.write(0x1001, 0x50);
    cpu.x = 0x01;
    cpu.y = 0x02;
    cpu.pc = 0x1000;

    expect(cpu.operand_address(s.bus, Immediate)).toBe(0x1000);
    cpu.pc = 0x1000;
    expect(cpu.operand_address(s.bus, ZeroPage)).toBe(0x40);
    cpu.pc = 0x1000;
    expect(cpu.operand_address(s.bus, ZeroPageX)).toBe(0x41);
  });

  test("addressing mode edge cases", () => {
    const s = create_test_cpu();
    const { cpu } = s;
    cpu.x = 0xff;
    cpu.pc = 0x1000;
    s.bus.write(0x1000, 0xff);
    expect(cpu.operand_address(s.bus, ZeroPageX)).toBe(0xfe);

    cpu.pc = 0x1000;
    cpu.y = 0xff;
    s.bus.write(0x1000, 0xff);
    s.bus.write(0x1001, 0x10); // 0x10FF
    const addr = cpu.operand_address(s.bus, AbsoluteY);
    expect(addr).toBe((0x10ff + 0xff) & 0xffff);
    expect(cpu.page_crossed).toBe(true);
  });

  test("LDA", () => {
    {
      const s = setup_with_program([0xa9, 0x42]); // LDA #$42
      const cycles = s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x42);
      expect(cycles).toBe(2);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(false);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(false);
    }
    {
      const s = setup_with_program([0xa9, 0x00]);
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x00);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    }
    {
      const s = setup_with_program([0xa9, 0x80]);
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x80);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    }
  });

  test("LDX / LDY", () => {
    {
      const s = setup_with_program([0xa2, 0x33]); // LDX #$33
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.x).toBe(0x33);
    }
    {
      const s = setup_with_program([0xa0, 0x44]); // LDY #$44
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.y).toBe(0x44);
    }
  });

  test("STA", () => {
    const s = setup_with_program([0x85, 0x10]); // STA $10
    s.cpu.a = 0x55;
    s.cpu.step(s.bus);
    expect(s.bus.read(0x10)).toBe(0x55);
  });

  test("ADC", () => {
    {
      const s = setup_with_program([0x69, 0x10]); // ADC #$10
      s.cpu.a = 0x20;
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x30);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(false);
    }
    {
      const s = setup_with_program([0x69, 0x80]);
      s.cpu.a = 0x80;
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x00);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    }
    {
      const s = setup_with_program([0x69, 0x01]);
      s.cpu.a = 0x7f;
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x80);
      expect(s.cpu.get_flag(FLAG_OVERFLOW)).toBe(true);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    }
  });

  test("SBC", () => {
    const s = setup_with_program([0xe9, 0x10]); // SBC #$10
    s.cpu.a = 0x30;
    s.cpu.set_flag(FLAG_CARRY, true);
    s.cpu.step(s.bus);
    expect(s.cpu.a).toBe(0x20);
    expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
  });

  test("CMP", () => {
    {
      const s = setup_with_program([0xc9, 0x10]); // CMP #$10
      s.cpu.a = 0x20;
      s.cpu.step(s.bus);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(false);
    }
    {
      const s = setup_with_program([0xc9, 0x20]);
      s.cpu.a = 0x20;
      s.cpu.step(s.bus);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    }
  });

  test("transfer instructions", () => {
    {
      const s = setup_with_program([0xaa]); // TAX
      s.cpu.a = 0x42;
      s.cpu.step(s.bus);
      expect(s.cpu.x).toBe(0x42);
    }
    {
      const s = setup_with_program([0x8a]); // TXA
      s.cpu.x = 0x33;
      s.cpu.a = 0x00;
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x33);
    }
  });

  test("flag instructions", () => {
    {
      const s = setup_with_program([0x18]); // CLC
      s.cpu.set_flag(FLAG_CARRY, true);
      s.cpu.step(s.bus);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(false);
    }
    {
      const s = setup_with_program([0x38]); // SEC
      s.cpu.set_flag(FLAG_CARRY, false);
      s.cpu.step(s.bus);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
    }
  });

  test("stack instructions PHA/PLA", () => {
    const s = setup_with_program([0x48, 0x68]); // PHA, PLA
    s.cpu.a = 0x55;
    const initial_sp = s.cpu.sp;
    s.cpu.step(s.bus);
    expect(s.cpu.sp).toBe(initial_sp - 1);
    s.cpu.a = 0x00;
    s.cpu.step(s.bus);
    expect(s.cpu.a).toBe(0x55);
    expect(s.cpu.sp).toBe(initial_sp);
  });

  test("branch on zero", () => {
    {
      const s = setup_with_program([0xf0, 0x05]); // BEQ +5
      s.cpu.set_flag(FLAG_ZERO, true);
      const pc0 = s.cpu.pc;
      const cycles = s.cpu.step(s.bus);
      expect(s.cpu.pc).toBe(pc0 + 2 + 5);
      expect(cycles).toBe(3);
    }
    {
      const s = setup_with_program([0xf0, 0x05]);
      s.cpu.set_flag(FLAG_ZERO, false);
      const pc0 = s.cpu.pc;
      const cycles = s.cpu.step(s.bus);
      expect(s.cpu.pc).toBe(pc0 + 2);
      expect(cycles).toBe(2);
    }
    {
      const s = setup_with_program([0xd0, 0x03]); // BNE +3
      s.cpu.set_flag(FLAG_ZERO, false);
      const pc0 = s.cpu.pc;
      const cycles = s.cpu.step(s.bus);
      expect(s.cpu.pc).toBe(pc0 + 2 + 3);
      expect(cycles).toBe(3);
    }
  });

  test("branch on carry / sign / overflow", () => {
    const cases: Array<[number[], number, boolean, number]> = [
      [[0x90, 0x10], FLAG_CARRY, false, 16], // BCC +16
      [[0xb0, 0x08], FLAG_CARRY, true, 8], // BCS +8
      [[0x10, 0x0a], FLAG_NEGATIVE, false, 10], // BPL +10
      [[0x30, 0x0c], FLAG_NEGATIVE, true, 12], // BMI +12
      [[0x50, 0x06], FLAG_OVERFLOW, false, 6], // BVC +6
      [[0x70, 0x04], FLAG_OVERFLOW, true, 4], // BVS +4
    ];
    for (const [program, flag, value, offset] of cases) {
      const s = setup_with_program(program);
      s.cpu.set_flag(flag, value);
      const pc0 = s.cpu.pc;
      expect(s.cpu.step(s.bus)).toBe(3);
      expect(s.cpu.pc).toBe(pc0 + 2 + offset);
    }
  });

  test("branch negative offset", () => {
    const s = create_test_cpu();
    s.cpu.pc = 0x0210;
    s.bus.write(0x0210, 0xf0); // BEQ
    s.bus.write(0x0211, 0xfc); // -4
    s.cpu.set_flag(FLAG_ZERO, true);
    expect(s.cpu.step(s.bus)).toBe(3);
    expect(s.cpu.pc).toBe(0x0212 - 4);
  });

  test("branch page crossing", () => {
    {
      const s = create_test_cpu();
      s.cpu.pc = 0x02fe;
      s.bus.write(0x02fe, 0xf0); // BEQ
      s.bus.write(0x02ff, 0x04); // 0x0300 -> 0x0304 同一ページ
      s.cpu.set_flag(FLAG_ZERO, true);
      expect(s.cpu.step(s.bus)).toBe(3);
    }
    {
      const s = create_test_cpu();
      s.cpu.pc = 0x02f0;
      s.bus.write(0x02f0, 0xf0); // BEQ
      s.bus.write(0x02f1, 0x20); // 0x02F2+0x20=0x0312 ページ跨ぎ
      s.cpu.set_flag(FLAG_ZERO, true);
      expect(s.cpu.step(s.bus)).toBe(4);
      expect(s.cpu.pc).toBe(0x02f2 + 0x20);
    }
  });

  test("JMP absolute", () => {
    const s = setup_with_program([0x4c, 0x34, 0x12]); // JMP $1234
    expect(s.cpu.step(s.bus)).toBe(3);
    expect(s.cpu.pc).toBe(0x1234);
  });

  test("JMP indirect", () => {
    const s = create_test_cpu();
    s.cpu.pc = 0x0200;
    s.bus.write(0x0200, 0x6c);
    s.bus.write(0x0201, 0x10);
    s.bus.write(0x0202, 0x03); // ($0310)
    s.bus.write(0x0310, 0x34);
    s.bus.write(0x0311, 0x12); // -> $1234
    expect(s.cpu.step(s.bus)).toBe(5);
    expect(s.cpu.pc).toBe(0x1234);
  });

  test("JMP indirect page-boundary bug", () => {
    const s = create_test_cpu();
    s.cpu.pc = 0x0200;
    s.bus.write(0x0200, 0x6c);
    s.bus.write(0x0201, 0xff);
    s.bus.write(0x0202, 0x03); // ($03FF)
    s.bus.write(0x03ff, 0x34);
    s.bus.write(0x0300, 0x12); // バグで high はここから読む
    s.bus.write(0x0400, 0x56);
    expect(s.cpu.step(s.bus)).toBe(5);
    expect(s.cpu.pc).toBe(0x1234);
  });

  test("JSR / RTS", () => {
    const s = create_test_cpu();
    s.cpu.pc = 0x0200;
    const initial_sp = s.cpu.sp;
    s.bus.write(0x0200, 0x20);
    s.bus.write(0x0201, 0x34);
    s.bus.write(0x0202, 0x12); // JSR $1234
    s.bus.write(0x1234, 0x60); // RTS

    expect(s.cpu.step(s.bus)).toBe(6);
    expect(s.cpu.pc).toBe(0x1234);
    expect(s.cpu.sp).toBe(initial_sp - 2);

    expect(s.cpu.step(s.bus)).toBe(6);
    expect(s.cpu.pc).toBe(0x0203);
    expect(s.cpu.sp).toBe(initial_sp);
  });

  test("AND / ORA / EOR", () => {
    {
      const s = setup_with_program([0x29, 0x0f]); // AND #$0F
      s.cpu.a = 0xff;
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.a).toBe(0x0f);
    }
    {
      const s = setup_with_program([0x09, 0x0f]); // ORA #$0F
      s.cpu.a = 0xf0;
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.a).toBe(0xff);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    }
    {
      const s = setup_with_program([0x49, 0xff]); // EOR #$FF
      s.cpu.a = 0xaa;
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.a).toBe(0x55);
    }
  });

  test("ASL / LSR / ROL / ROR accumulator", () => {
    {
      const s = setup_with_program([0x0a]); // ASL A
      s.cpu.a = 0x40;
      s.cpu.set_flag(FLAG_CARRY, false);
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.a).toBe(0x80);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(false);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    }
    {
      const s = setup_with_program([0x4a]); // LSR A
      s.cpu.a = 0x81;
      s.cpu.set_flag(FLAG_CARRY, false);
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.a).toBe(0x40);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
    }
    {
      const s = setup_with_program([0x2a]); // ROL A
      s.cpu.a = 0x40;
      s.cpu.set_flag(FLAG_CARRY, true);
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x81);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(false);
    }
    {
      const s = setup_with_program([0x6a]); // ROR A
      s.cpu.a = 0x02;
      s.cpu.set_flag(FLAG_CARRY, true);
      s.cpu.step(s.bus);
      expect(s.cpu.a).toBe(0x81);
      expect(s.cpu.get_flag(FLAG_CARRY)).toBe(false);
      expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    }
  });

  test("shift memory (ASL $10)", () => {
    const s = create_test_cpu();
    s.cpu.pc = 0x0200;
    s.bus.write(0x0200, 0x06); // ASL $10
    s.bus.write(0x0201, 0x10);
    s.bus.write(0x0010, 0x40);
    expect(s.cpu.step(s.bus)).toBe(5);
    expect(s.bus.read(0x0010)).toBe(0x80);
  });

  test("INC/DEC registers", () => {
    {
      const s = setup_with_program([0xe8]); // INX
      s.cpu.x = 0x42;
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.x).toBe(0x43);
    }
    {
      const s = setup_with_program([0x88]); // DEY
      s.cpu.y = 0x01;
      expect(s.cpu.step(s.bus)).toBe(2);
      expect(s.cpu.y).toBe(0x00);
      expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    }
  });

  test("CPX / CPY", () => {
    const s = setup_with_program([0xe0, 0x42]); // CPX #$42
    s.cpu.x = 0x42;
    expect(s.cpu.step(s.bus)).toBe(2);
    expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    expect(s.cpu.get_flag(FLAG_CARRY)).toBe(true);
  });

  test("BIT", () => {
    const s = setup_with_program([0x24, 0x10]); // BIT $10
    s.cpu.a = 0x0f;
    s.bus.write(0x0010, 0xc0); // bit7,6 セット
    expect(s.cpu.step(s.bus)).toBe(3);
    expect(s.cpu.get_flag(FLAG_ZERO)).toBe(true);
    expect(s.cpu.get_flag(FLAG_NEGATIVE)).toBe(true);
    expect(s.cpu.get_flag(FLAG_OVERFLOW)).toBe(true);
  });
});
