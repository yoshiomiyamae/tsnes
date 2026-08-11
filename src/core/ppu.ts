// Picture Processing Unit（移植元 cppnes `ppu.hpp` / `ppu.cpp`）。
//
// Bus が PPU と Cartridge を別で所有するため、CHR/ミラーリング/A12/IRQ が必要な
// メソッドは Cartridge を引数で受け取る（null=未接続）。サイクル精度のトリック
// （VBL/NMI レース窓、MMC3 A12 クロック、奇数フレームスキップ）は移植元コメントを
// 仕様として忠実に再現する。
import type { Cartridge } from "./cartridge.ts";
import { PaletteManager } from "./palette.ts";
import type { StateReader, StateWriter } from "./savestate.ts";

// 画面サイズ（NTSC 可視領域）。
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 240;

// PPUCTRL フラグ
export const PPUCTRL_INCREMENT = 0x04;
export const PPUCTRL_SPRITE_TABLE = 0x08;
export const PPUCTRL_BG_TABLE = 0x10;
export const PPUCTRL_SPRITE_SIZE = 0x20;
export const PPUCTRL_NMI_ENABLE = 0x80;
// PPUMASK フラグ
export const PPUMASK_BG_LEFT = 0x02;
export const PPUMASK_SPRITE_LEFT = 0x04;
export const PPUMASK_BG_SHOW = 0x08;
export const PPUMASK_SPRITE_SHOW = 0x10;
// PPUSTATUS フラグ
export const PPUSTATUS_SPRITE_OVERFLOW = 0x20;
export const PPUSTATUS_SPRITE0_HIT = 0x40;
export const PPUSTATUS_VBLANK = 0x80;

// ミラーリングコード（Cartridge.get_mirroring と一致）。
const MIRRORING_HORIZONTAL = 0;
const MIRRORING_VERTICAL = 1;
const MIRRORING_SINGLE_LOWER = 2;
const MIRRORING_SINGLE_UPPER = 3;

// スプライト属性フラグ
const SPRITE_FLIP_HORIZONTAL = 0x40;
const SPRITE_FLIP_VERTICAL = 0x80;
const SPRITE_PRIORITY = 0x20;
const SPRITE_PALETTE_MASK = 0x03;

// 未リフレッシュビットが 0 として読まれるまでのフレーム数（open bus decay）。
const OPEN_BUS_DECAY_FRAMES = 30;
// VBL フラグセットから NMI ライン assert までの PPU サイクル遅延。
const NMI_ASSERT_DELAY_PPU_CYCLES = 2;

const TOTAL_OAM_SPRITES = 64;
const MAX_SPRITES_PER_SCANLINE = 8;

// スプライト（OAM インデックスとそのスキャンライン行のパターンバイト込み）。
interface SpriteInfo {
  y: number;
  tile_index: number;
  attributes: number;
  x: number;
  oam_index: number;
  pattern_lo: number;
  pattern_hi: number;
}

export class Ppu {
  // レジスタ
  ppuctrl = 0;
  ppumask = 0;
  ppustatus = 0;
  oamaddr = 0;

  // タイミング
  cycle = 0;
  scanline = 0;
  frame = 0;
  frame_complete = false;

  // NMI
  nmi_requested = false;
  // カートリッジ IRQ ラインのミラー（Nes.step が毎 PPU サイクル読む）。
  mapper_irq = false;

  readonly palette = new PaletteManager();
  // 8 スプライト/スキャンライン制限を無効化する表示設定。
  no_sprite_limit = false;

  readonly vram = new Uint8Array(0x4000);
  readonly oam = new Uint8Array(256);
  // 256×240 ARGB 出力。
  readonly frame_buffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  // 内部レジスタ（テストから参照するため public。C++ では private + friend）。
  /** @internal */ v = 0;
  /** @internal */ t = 0;
  /** @internal */ x = 0;
  /** @internal */ x_temp = 0;
  /** @internal */ w = 0;

  private mmc3_first_clock_pending = false;
  private render_enabled = false;
  private mapper_tick_cycle = 273;
  private vbl_suppressed = false;
  private nmi_assert_countdown = 0;
  private odd_frame = false;

  private open_bus_value = 0;
  private readonly open_bus_decay_frame = new Float64Array(8);

  private cached_mirroring = MIRRORING_HORIZONTAL;

  // 現在の背景タイル（属性とパターン行）。割り当てを避けるため使い回す。
  private bg_attributes = 0;
  private bg_pattern_lo = 0;
  private bg_pattern_hi = 0;
  private current_bg_tile_x = -1;

  private current_sprite_count = 0;
  /** @internal */ read_buffer = 0;
  private dynamic_mirroring = false;
  private readonly current_sprites: SpriteInfo[] = Array.from(
    { length: TOTAL_OAM_SPRITES },
    () => ({ y: 0, tile_index: 0, attributes: 0, x: 0, oam_index: 0, pattern_lo: 0, pattern_hi: 0 }),
  );

  // スキャンライン 1 本分に展開したスプライト画素（build_sprite_line が埋める）。
  // bit0-1=カラーインデックス(0=スプライト無し) / bit2-3=パレット /
  // bit4=priority_front / bit5=sprite0。**色そのものは入れない** — パレット RAM は
  // ラスタ途中で書き換わり得るので、ARGB への解決は画素ごとに行う（C++ と同じ）。
  private readonly sprite_line_ = new Uint8Array(SCREEN_WIDTH);

  // sprite_pixel_at の戻り値（割り当て回避）。
  private sp_color = 0;
  private sp_priority_front = false;
  private sp_is_sprite0 = false;

  private refresh_derived_ctrl(): void {
    this.render_enabled = this.rendering_enabled();
    this.mapper_tick_cycle = this.ppuctrl & PPUCTRL_BG_TABLE ? 337 : 273;
  }

  reset(): void {
    this.ppuctrl = 0;
    this.ppumask = 0;
    this.ppustatus = 0;
    this.oamaddr = 0;
    this.v = 0;
    this.t = 0;
    this.x = 0;
    this.w = 0;
    this.cycle = 0;
    this.scanline = 0;
    this.frame_complete = false;
    this.current_bg_tile_x = -1;
    this.refresh_derived_ctrl();
    this.palette.set_emphasis(0);
  }

  attach_cartridge(cart: Cartridge | null): void {
    if (cart !== null) {
      this.dynamic_mirroring = cart.has_expansion();
    }
    this.refresh_mirroring_cache(cart);
  }

  rendering_enabled(): boolean {
    return (this.ppumask & (PPUMASK_BG_SHOW | PPUMASK_SPRITE_SHOW)) !== 0;
  }

  save_state(w_: StateWriter): void {
    w_.u8(this.ppuctrl);
    w_.u8(this.ppumask);
    w_.u8(this.ppustatus);
    w_.u8(this.oamaddr);
    w_.u16(this.v);
    w_.u16(this.t);
    w_.u8(this.x);
    w_.u8(this.x_temp);
    w_.u8(this.w);
    w_.i32(this.cycle);
    w_.i32(this.scanline);
    w_.u64(this.frame);
    w_.boolean(this.frame_complete);
    w_.boolean(this.nmi_requested);
    w_.boolean(this.mapper_irq);
    w_.boolean(this.mmc3_first_clock_pending);
    w_.boolean(this.render_enabled);
    w_.i32(this.mapper_tick_cycle);
    w_.boolean(this.vbl_suppressed);
    w_.u8(this.nmi_assert_countdown);
    w_.boolean(this.odd_frame);
    w_.u8(this.open_bus_value);
    for (let i = 0; i < 8; i++) {
      w_.u64(this.open_bus_decay_frame[i]!);
    }
    w_.i32(this.cached_mirroring);
    w_.u8(this.read_buffer);
    w_.boolean(this.dynamic_mirroring);
    w_.bytes(this.vram);
    w_.bytes(this.oam);
    w_.bytes(this.palette.palette_ram);
    w_.u8(this.palette.emphasis);
  }

  load_state(r: StateReader): void {
    this.ppuctrl = r.u8();
    this.ppumask = r.u8();
    this.ppustatus = r.u8();
    this.oamaddr = r.u8();
    this.v = r.u16();
    this.t = r.u16();
    this.x = r.u8();
    this.x_temp = r.u8();
    this.w = r.u8();
    this.cycle = r.i32();
    this.scanline = r.i32();
    this.frame = r.u64();
    this.frame_complete = r.boolean();
    this.nmi_requested = r.boolean();
    this.mapper_irq = r.boolean();
    this.mmc3_first_clock_pending = r.boolean();
    this.render_enabled = r.boolean();
    this.mapper_tick_cycle = r.i32();
    this.vbl_suppressed = r.boolean();
    this.nmi_assert_countdown = r.u8();
    this.odd_frame = r.boolean();
    this.open_bus_value = r.u8();
    for (let i = 0; i < 8; i++) {
      this.open_bus_decay_frame[i] = r.u64();
    }
    this.cached_mirroring = r.i32();
    this.read_buffer = r.u8();
    this.dynamic_mirroring = r.boolean();
    r.read_into(this.vram);
    r.read_into(this.oam);
    r.read_into(this.palette.palette_ram);
    this.palette.emphasis = r.u8();
    // 直接代入したパレット RAM/エンファシスから派生色キャッシュを再構築。
    this.palette.rebuild_color_cache();
    // レンダキャッシュを無効化。
    this.current_bg_tile_x = -1;
    this.current_sprite_count = 0;
  }

  consume_nmi(): boolean {
    if (!this.nmi_requested) {
      return false;
    }
    this.nmi_requested = false;
    return true;
  }

  // フレームバッファを RGBA バイト列に変換する（Canvas ImageData 用）。
  framebuffer_rgba(): Uint8Array {
    const rgba = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    const fb = this.frame_buffer;
    for (let i = 0; i < fb.length; i++) {
      const pixel = fb[i]!;
      rgba[i * 4] = (pixel >> 16) & 0xff;
      rgba[i * 4 + 1] = (pixel >> 8) & 0xff;
      rgba[i * 4 + 2] = pixel & 0xff;
      rgba[i * 4 + 3] = (pixel >>> 24) & 0xff;
    }
    return rgba;
  }

  // ---- メインステップ ----

  step(cart: Cartridge | null): void {
    this.step_n(1, cart);
  }

  step_n(n: number, cart: Cartridge | null): void {
    let cyc = this.cycle;
    let sl = this.scanline;

    for (let iter = 0; iter < n; iter++) {
      // NMI assert カウントダウン。
      if (this.nmi_assert_countdown > 0) {
        this.nmi_assert_countdown = (this.nmi_assert_countdown - 1) & 0xff;
        if (
          this.nmi_assert_countdown === 0 &&
          this.ppuctrl & PPUCTRL_NMI_ENABLE &&
          this.ppustatus & PPUSTATUS_VBLANK
        ) {
          this.nmi_requested = true;
        }
      }

      // 可視ピクセルのみ描画。
      if (sl >= 0 && sl < 240 && cyc < 256) {
        this.render_pixel(cyc, sl, cart);
      }

      // MMC3 IRQ + per-scanline Y インクリメント。
      const rendering_active = sl < 240 && this.render_enabled;
      if (rendering_active && cart !== null) {
        let clock_mapper = cyc === this.mapper_tick_cycle;
        if (
          !clock_mapper &&
          this.mmc3_first_clock_pending &&
          this.mapper_tick_cycle === 337 &&
          cyc === 17
        ) {
          clock_mapper = true;
          this.mmc3_first_clock_pending = false;
        }
        if (clock_mapper) {
          cart.step();
          this.mapper_irq = cart.is_irq_pending();
        }
      }
      if (rendering_active && cyc === 256) {
        this.increment_y();
      }

      cyc++;
      if (cyc >= 341) {
        cyc = 0;
        this.refresh_mirroring_cache(cart);

        sl++;
        // 奇数フレームスキップ
        if (sl === 0 && this.odd_frame && this.ppumask & PPUMASK_BG_SHOW) {
          cyc = 1;
        }
        if (sl >= 0 && sl < 240 && cart !== null) {
          cart.notify_scanline(sl, this.rendering_enabled());
        }

        if (sl === 241) {
          if (!this.vbl_suppressed) {
            this.ppustatus = (this.ppustatus | PPUSTATUS_VBLANK) & 0xff;
            if (this.ppuctrl & PPUCTRL_NMI_ENABLE) {
              this.nmi_assert_countdown = NMI_ASSERT_DELAY_PPU_CYCLES;
            }
          }
          this.vbl_suppressed = false;
        }

        if (sl >= 261) {
          sl = -1; // プリレンダ
          this.ppustatus = this.ppustatus & ~PPUSTATUS_VBLANK & 0xff;
          this.ppustatus = this.ppustatus & ~PPUSTATUS_SPRITE0_HIT & 0xff;
          this.ppustatus = this.ppustatus & ~PPUSTATUS_SPRITE_OVERFLOW & 0xff;
          this.frame_complete = true;
          this.frame++;
          this.odd_frame = !this.odd_frame;
        }
      }

      // プリレンダスキャンライン
      if (sl === -1) {
        if (cyc === 304 && this.rendering_enabled()) {
          this.v = ((this.v & 0x841f) | (this.t & 0x7be0)) & 0xffff;
        }
        if (cyc === 257 && this.rendering_enabled()) {
          this.v = ((this.v & 0xfbe0) | (this.t & 0x041f)) & 0xffff;
        }
      }

      // 各可視スキャンライン開始で水平スクロールを t から v へコピー。
      if (sl >= 0 && sl < 240 && cyc === 0 && this.rendering_enabled()) {
        this.v = ((this.v & 0xfbe0) | (this.t & 0x041f)) & 0xffff;
        this.x = this.x_temp;
        this.current_bg_tile_x = -1;
      }
    }

    this.cycle = cyc;
    this.scanline = sl;
  }

  private increment_y(): void {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v = (this.v + 0x1000) & 0xffff;
      return;
    }
    this.v = this.v & 0x8fff; // fine Y = 0
    let y = (this.v >> 5) & 0x1f;
    if (y === 29) {
      y = 0;
      this.v = (this.v ^ 0x0800) & 0xffff;
    } else if (y === 31) {
      y = 0;
    } else {
      y += 1;
    }
    this.v = ((this.v & ~0x03e0) | (y << 5)) & 0xffff;
  }

  // ---- VRAM アクセス ----

  private read_vram(addr: number, cart: Cartridge | null): number {
    return this.read_vram_internal(addr, false, cart);
  }

  private read_vram_sprite(addr: number, cart: Cartridge | null): number {
    return this.read_vram_internal(addr, true, cart);
  }

  private read_vram_internal(addr: number, sprite: boolean, cart: Cartridge | null): number {
    addr = addr % 0x4000;
    if (addr < 0x2000) {
      if (cart !== null) {
        return sprite ? cart.read_chr_sprite(addr) : cart.read_chr(addr);
      }
      return 0;
    }
    if (addr < 0x3f00) {
      return this.read_name_table(addr, cart);
    }
    return this.palette.read_palette(addr & 0x1f);
  }

  private write_vram(addr: number, value: number, cart: Cartridge | null): void {
    addr = addr % 0x4000;
    if (this.dynamic_mirroring && addr >= 0x2000 && addr < 0x3f00) {
      this.refresh_mirroring_cache(cart);
    }
    if (addr < 0x2000) {
      if (cart !== null) {
        cart.write_chr(addr, value);
      }
    } else if (addr < 0x3f00) {
      this.vram[this.mirror_name_table_address(addr)] = value;
    } else {
      this.palette.write_palette(addr & 0x1f, value);
    }
  }

  private read_name_table(addr: number, cart: Cartridge | null): number {
    if (this.dynamic_mirroring) {
      this.refresh_mirroring_cache(cart);
    }
    return this.vram[this.mirror_name_table_address(addr)]!;
  }

  private mirror_name_table_address(addr: number): number {
    const offset = (addr - 0x2000) & 0xffff;
    switch (this.cached_mirroring) {
      case MIRRORING_HORIZONTAL:
        return (((offset & 0x800) >> 1) | (offset & 0x3ff)) + 0x2000;
      case MIRRORING_VERTICAL:
        return (offset & 0x7ff) + 0x2000;
      case MIRRORING_SINGLE_LOWER:
        return (offset & 0x3ff) + 0x2000;
      case MIRRORING_SINGLE_UPPER:
        return (offset & 0x3ff) + 0x2400;
      default:
        return addr; // 4 画面
    }
  }

  private refresh_mirroring_cache(cart: Cartridge | null): void {
    this.cached_mirroring = cart !== null ? cart.get_mirroring() : MIRRORING_HORIZONTAL;
  }

  // ---- open bus decay ----

  private refresh_open_bus(value: number, mask: number): void {
    this.open_bus_value = ((this.open_bus_value & ~mask) | (value & mask)) & 0xff;
    const f = this.frame;
    if (mask === 0xff) {
      this.open_bus_decay_frame.fill(f);
      return;
    }
    for (let i = 0; i < 8; i++) {
      if (mask & (1 << i)) {
        this.open_bus_decay_frame[i] = f;
      }
    }
  }

  private read_open_bus(): number {
    let result = 0;
    const f = this.frame;
    for (let i = 0; i < 8; i++) {
      // C++ は uint64 の減算なので decay > f のとき巨大値になり false。TS では
      // 負値になるため、明示的に非負条件を置いて同じ挙動にする。
      const age = f - this.open_bus_decay_frame[i]!;
      if (age >= 0 && age < OPEN_BUS_DECAY_FRAMES) {
        result = result | (this.open_bus_value & (1 << i));
      }
    }
    return result & 0xff;
  }

  // ---- レジスタ I/O ----

  read_register(addr: number, cart: Cartridge | null): number {
    switch (addr) {
      case 0x2002: {
        // VBL レース: VBL セット直前サイクルの読みはフラグセットと NMI を抑制。
        if (this.scanline === 240 && this.cycle === 340) {
          this.vbl_suppressed = true;
        }
        const status_bits = this.ppustatus & 0xe0;
        this.refresh_open_bus(status_bits, 0xe0);
        this.ppustatus = this.ppustatus & ~PPUSTATUS_VBLANK & 0xff;
        this.w = 0;
        return (status_bits | (this.read_open_bus() & 0x1f)) & 0xff;
      }
      case 0x2004: {
        let value = this.oam[this.oamaddr]!;
        if ((this.oamaddr & 3) === 2) {
          value = value & 0xe3; // bit2-4 は未実装で 0 読み
        }
        this.refresh_open_bus(value, 0xff);
        return value;
      }
      case 0x2007: {
        const read_addr = this.v & 0x3fff;
        const is_palette = read_addr >= 0x3f00;
        let value: number;
        if (is_palette) {
          value = this.read_vram(read_addr, cart) & 0x3f;
          this.read_buffer = this.read_vram((read_addr - 0x1000) & 0xffff, cart);
        } else {
          value = this.read_buffer;
          this.read_buffer = this.read_vram(read_addr, cart);
        }
        this.increment_vram_address();
        this.notify_cartridge_a12(cart);
        if (is_palette) {
          this.refresh_open_bus(value, 0x3f);
          return (value | (this.read_open_bus() & 0xc0)) & 0xff;
        }
        this.refresh_open_bus(value, 0xff);
        return value;
      }
      default:
        return this.read_open_bus();
    }
  }

  write_register(addr: number, value: number, cart: Cartridge | null): void {
    this.refresh_open_bus(value, 0xff);
    switch (addr) {
      case 0x2000: {
        const old = this.ppuctrl;
        this.ppuctrl = value;
        this.refresh_derived_ctrl();
        this.t = ((this.t & 0xf3ff) | ((value & 0x03) << 10)) & 0xffff;
        if (
          (old & PPUCTRL_NMI_ENABLE) === 0 &&
          value & PPUCTRL_NMI_ENABLE &&
          this.ppustatus & PPUSTATUS_VBLANK
        ) {
          this.nmi_requested = true; // 即時 NMI
        }
        if ((old & PPUCTRL_SPRITE_SIZE) !== (value & PPUCTRL_SPRITE_SIZE) && cart !== null) {
          cart.set_sprite_size((value & PPUCTRL_SPRITE_SIZE) !== 0);
        }
        break;
      }
      case 0x2001: {
        const old = this.ppumask;
        this.ppumask = value;
        this.refresh_derived_ctrl();
        this.palette.set_emphasis(value & 0xe0);
        const RENDER_SHOW = PPUMASK_BG_SHOW | PPUMASK_SPRITE_SHOW;
        if ((old & RENDER_SHOW) === 0 && value & RENDER_SHOW) {
          this.mmc3_first_clock_pending = true;
        }
        break;
      }
      case 0x2003:
        this.oamaddr = value;
        break;
      case 0x2004:
        this.oam[this.oamaddr] = value;
        this.oamaddr = (this.oamaddr + 1) & 0xff;
        break;
      case 0x2005:
        if (this.w === 0) {
          this.t = ((this.t & 0xffe0) | (value >> 3)) & 0xffff;
          this.x_temp = value & 0x07;
          this.w = 1;
        } else {
          this.t = ((this.t & 0x8fff) | ((value & 0x07) << 12)) & 0xffff;
          this.t = ((this.t & 0xfc1f) | ((value & 0xf8) << 2)) & 0xffff;
          this.w = 0;
        }
        break;
      case 0x2006:
        if (this.w === 0) {
          this.t = ((this.t & 0x80ff) | ((value & 0x3f) << 8)) & 0xffff;
          this.w = 1;
        } else {
          this.t = ((this.t & 0xff00) | value) & 0xffff;
          this.v = this.t;
          this.w = 0;
          this.notify_cartridge_a12(cart); // v 確定で A12 がフリップし得る
        }
        break;
      case 0x2007:
        this.write_vram(this.v, value, cart);
        this.increment_vram_address();
        this.notify_cartridge_a12(cart);
        break;
      default:
        break;
    }
  }

  private notify_cartridge_a12(cart: Cartridge | null): void {
    if (cart !== null) {
      cart.notify_a12(this.v, this.rendering_enabled());
      this.mapper_irq = cart.is_irq_pending();
    }
  }

  private increment_vram_address(): void {
    this.v = (this.v + (this.ppuctrl & PPUCTRL_INCREMENT ? 32 : 1)) & 0xffff;
  }

  // ---- レンダラ ----

  // 背景タイルをフェッチし、bg_attributes / bg_pattern_lo / bg_pattern_hi に置く。
  private fetch_background_tile_with_scroll(tile_x: number, cart: Cartridge | null): void {
    const coarse_x = this.v & 0x1f;
    const scrolled_tile_y = (this.v >> 5) & 0x1f;
    let scrolled_tile_x = coarse_x + tile_x;

    let name_table_x = 0;
    if (scrolled_tile_x >= 32) {
      name_table_x = 1;
      scrolled_tile_x -= 32;
    }

    const base_ntx = (this.v >> 10) & 1;
    const base_nty = (this.v >> 11) & 1;
    const final_ntx = (base_ntx + name_table_x) % 2;
    const final_nty = base_nty;

    const name_table_index = final_nty * 2 + final_ntx;
    const name_table_base = 0x2000 + name_table_index * 0x400;
    const name_table_addr = name_table_base + (scrolled_tile_y * 32 + scrolled_tile_x);

    const tile_index = this.read_vram(name_table_addr, cart);

    const attr_addr =
      name_table_base + 0x3c0 + ((scrolled_tile_y >> 2) * 8 + (scrolled_tile_x >> 2));
    const attr_byte = this.read_vram(attr_addr, cart);
    const attr_shift = ((scrolled_tile_y & 2) * 2) + (scrolled_tile_x & 2);
    this.bg_attributes = (attr_byte >> attr_shift) & 0x03;

    const pattern_table_base = this.ppuctrl & PPUCTRL_BG_TABLE ? 0x1000 : 0x0000;
    const tile_addr = (pattern_table_base + tile_index * 16) & 0xffff;
    const fine_y = (this.v >> 12) & 0x07;

    this.bg_pattern_lo = this.read_vram((tile_addr + fine_y) & 0xffff, cart);
    this.bg_pattern_hi = this.read_vram((tile_addr + fine_y + 8) & 0xffff, cart);
  }

  private static get_pixel_color(pattern_lo: number, pattern_hi: number, pixel_x: number): number {
    const bit_pos = 7 - pixel_x;
    const low_bit = (pattern_lo >> bit_pos) & 1;
    const high_bit = (pattern_hi >> bit_pos) & 1;
    return ((high_bit << 1) | low_bit) & 0xff;
  }

  private evaluate_sprites(scanline_: number, cart: Cartridge | null): void {
    const sprite_height = this.ppuctrl & PPUCTRL_SPRITE_SIZE ? 16 : 8;

    let count = 0;
    for (let i = 0; i < TOTAL_OAM_SPRITES; i++) {
      const sprite_y = this.oam[i * 4]! + 1;
      if (scanline_ >= sprite_y && scanline_ < sprite_y + sprite_height) {
        if (count >= MAX_SPRITES_PER_SCANLINE) {
          this.ppustatus = (this.ppustatus | PPUSTATUS_SPRITE_OVERFLOW) & 0xff;
          if (!this.no_sprite_limit) {
            break;
          }
        }
        const s = this.current_sprites[count]!;
        s.y = this.oam[i * 4]!;
        s.tile_index = this.oam[i * 4 + 1]!;
        s.attributes = this.oam[i * 4 + 2]!;
        s.x = this.oam[i * 4 + 3]!;
        s.oam_index = i;
        this.fetch_sprite_pattern(s, scanline_, sprite_height, cart);
        count++;
      }
    }
    this.current_sprite_count = count;
    this.build_sprite_line();

    // 次スキャンラインのオーバーフロー先読み（独立カウント）。
    const next = scanline_ + 1;
    let lookahead = 0;
    for (let i = 0; i < TOTAL_OAM_SPRITES; i++) {
      const sprite_y = this.oam[i * 4]! + 1;
      if (next >= sprite_y && next < sprite_y + sprite_height) {
        lookahead++;
        if (lookahead > MAX_SPRITES_PER_SCANLINE) {
          this.ppustatus = (this.ppustatus | PPUSTATUS_SPRITE_OVERFLOW) & 0xff;
          break;
        }
      }
    }
  }

  private fetch_sprite_pattern(
    sprite: SpriteInfo,
    scanline_: number,
    sprite_height: number,
    cart: Cartridge | null,
  ): void {
    let pixel_y = scanline_ - (sprite.y + 1);
    if (sprite.attributes & SPRITE_FLIP_VERTICAL) {
      pixel_y = sprite_height - 1 - pixel_y;
    }

    let tile_addr: number;
    if (sprite_height === 16) {
      // 8×16: tile index の bit0 がパターンテーブル選択、残りが（偶数）上タイル。
      let tile_index = sprite.tile_index & 0xfe;
      if (pixel_y >= 8) {
        tile_index += 1;
        pixel_y -= 8;
      }
      const base = sprite.tile_index & 1 ? 0x1000 : 0x0000;
      tile_addr = (base + tile_index * 16 + pixel_y) & 0xffff;
    } else {
      const base = this.ppuctrl & PPUCTRL_SPRITE_TABLE ? 0x1000 : 0x0000;
      tile_addr = (base + sprite.tile_index * 16 + pixel_y) & 0xffff;
    }

    sprite.pattern_lo = this.read_vram_sprite(tile_addr, cart);
    sprite.pattern_hi = this.read_vram_sprite((tile_addr + 8) & 0xffff, cart);
  }

  // evaluate_sprites の結果からスキャンライン 1 本分のスプライト画素を先に展開する。
  //
  // C++ は画素ごとに 8 個のスプライトを走査するが、走査対象（x/属性/パターン）は
  // スキャンライン中は不変なので、OAM 順に前から埋めて「先に書いた方が勝ち」に
  // すれば同じ結果になる（C++ の「最初に色 0 でないスプライトを採用」と等価）。
  // マスク（$2001）だけはスキャンライン途中で変わり得るので画素ごとに見る。
  private build_sprite_line(): void {
    this.sprite_line_.fill(0);
    for (let i = 0; i < this.current_sprite_count; i++) {
      const sprite = this.current_sprites[i]!;
      const attrs =
        ((sprite.attributes & SPRITE_PALETTE_MASK) << 2) |
        ((sprite.attributes & SPRITE_PRIORITY) === 0 ? 0x10 : 0) |
        (sprite.oam_index === 0 ? 0x20 : 0);
      const flip_h = (sprite.attributes & SPRITE_FLIP_HORIZONTAL) !== 0;
      const sprite_x = sprite.x;
      for (let k = 0; k < 8; k++) {
        const px = sprite_x + k;
        if (px >= SCREEN_WIDTH) break;
        // カラーインデックス 0（透明）は書かないので、0 が「未書き込み」を表す。
        if (this.sprite_line_[px] !== 0) continue;
        const color_index = Ppu.get_pixel_color(
          sprite.pattern_lo,
          sprite.pattern_hi,
          flip_h ? 7 - k : k,
        );
        if (color_index === 0) continue;
        this.sprite_line_[px] = attrs | color_index;
      }
    }
  }

  // px 位置のスプライト画素を取り出し、sp_color / sp_priority_front / sp_is_sprite0 に置く。
  private sprite_pixel_at(px: number): void {
    this.sp_color = 0;
    this.sp_priority_front = false;
    this.sp_is_sprite0 = false;

    if ((this.ppumask & PPUMASK_SPRITE_SHOW) === 0) {
      return;
    }
    if (px < 8 && (this.ppumask & PPUMASK_SPRITE_LEFT) === 0) {
      return;
    }

    const entry = this.sprite_line_[px]!;
    const color_index = entry & 3;
    if (color_index === 0) {
      return;
    }
    // 色の解決はここで行う（パレット RAM のラスタ途中変更を取りこぼさないため）。
    this.sp_color = this.palette.sprite_color((entry >> 2) & 3, color_index);
    this.sp_priority_front = (entry & 0x10) !== 0;
    this.sp_is_sprite0 = (entry & 0x20) !== 0;
  }

  private render_pixel(px: number, py: number, cart: Cartridge | null): void {
    const index = py * 256 + px;

    if (!this.render_enabled) {
      this.frame_buffer[index] = this.palette.background_color(0, 0);
      return;
    }

    let bg_color_index = 0;
    let bg_color: number;
    if (
      (this.ppumask & PPUMASK_BG_SHOW) === 0 ||
      (px < 8 && (this.ppumask & PPUMASK_BG_LEFT) === 0)
    ) {
      bg_color = this.palette.background_color(0, 0);
    } else {
      const adjusted_x = px + this.x; // fine X
      const tile_x = adjusted_x >> 3;
      if (tile_x !== this.current_bg_tile_x) {
        this.fetch_background_tile_with_scroll(tile_x, cart);
        this.current_bg_tile_x = tile_x;
      }
      bg_color_index = Ppu.get_pixel_color(this.bg_pattern_lo, this.bg_pattern_hi, adjusted_x & 7);
      bg_color = this.palette.background_color(this.bg_attributes, bg_color_index);
    }

    // スプライト評価はスキャンライン毎に 1 度。
    if (px === 0) {
      this.evaluate_sprites(py, cart);
    }

    let final_color = bg_color;
    if (this.current_sprite_count > 0) {
      this.sprite_pixel_at(px);
      if (this.sp_color & 0xff000000) {
        const bg_opaque = bg_color_index !== 0;
        if (this.sp_priority_front || !bg_opaque) {
          final_color = this.sp_color;
        }
        // スプライト 0 ヒット（x=255 では発火しない）。
        if (this.sp_is_sprite0 && (this.ppustatus & PPUSTATUS_SPRITE0_HIT) === 0 && px !== 255) {
          const sprite_enabled = (this.ppumask & PPUMASK_SPRITE_SHOW) !== 0;
          const bg_enabled = (this.ppumask & PPUMASK_BG_SHOW) !== 0;
          const left_clipped =
            px < 8 &&
            (this.ppumask & (PPUMASK_SPRITE_LEFT | PPUMASK_BG_LEFT)) !==
              (PPUMASK_SPRITE_LEFT | PPUMASK_BG_LEFT);
          if (bg_opaque && sprite_enabled && bg_enabled && !left_clipped) {
            this.ppustatus = (this.ppustatus | PPUSTATUS_SPRITE0_HIT) & 0xff;
          }
        }
      }
    }

    this.frame_buffer[index] = final_color;
  }
}
