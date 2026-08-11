// コアの公開 API（移植元 cppnes `core/include/cppnes/*.hpp` に対応）。
// ランタイム非依存: DOM も bun API も使わない。
export { Nes } from "./nes.ts";
export { Bus, OAM_DMA_STALL_CYCLES } from "./bus.ts";
export { Cpu, AddressingMode } from "./cpu.ts";
export {
  Ppu,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  PPUCTRL_NMI_ENABLE,
  PPUMASK_BG_SHOW,
  PPUMASK_SPRITE_SHOW,
  PPUSTATUS_VBLANK,
  PPUSTATUS_SPRITE0_HIT,
  PPUSTATUS_SPRITE_OVERFLOW,
} from "./ppu.ts";
export { Apu, NUM_CHANNELS } from "./apu.ts";
export { PaletteManager } from "./palette.ts";
export { Cartridge, MirroringMode } from "./cartridge.ts";
export { Mapper, type CartridgeData } from "./mapper.ts";
export { make_mapper } from "./mapper/factory.ts";
export {
  Controller,
  BUTTON_A,
  BUTTON_B,
  BUTTON_SELECT,
  BUTTON_START,
  BUTTON_UP,
  BUTTON_DOWN,
  BUTTON_LEFT,
  BUTTON_RIGHT,
} from "./input.ts";
export { CheatManager, decode_game_genie, load_str, parse_line, type Cheat } from "./cheat.ts";
export {
  StateReader,
  StateWriter,
  StateError,
  StateErrorKind,
  STATE_MAGIC,
  STATE_VERSION,
} from "./savestate.ts";
