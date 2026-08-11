# tsnes 開発計画 — cppnes の TypeScript 移植（ブラウザ動作）

`../cppnes`（C++23 製 NES エミュレータ、コア約 5,400 行 + SDL フロント 1,600 行）を
**TypeScript へ移植し、ブラウザで動作させる**。cppnes 自体が `../rsnes`（Rust）→
`../gones`（Go）の系譜なので、設計（中央集権 `Bus`、`Mapper` 多態、サイクル精度 6502、
スキャンライン PPU、フィルタ付き APU）はそのまま写せる。

**cppnes を「正解」とし、同じテスト群（ユニット + テスト ROM + nestest ログ差分 +
フレームバッファハッシュ）で挙動の同一性を検証する。**

ランタイム/ツールチェーンは **bun**（テスト・バンドル・ヘッドレス実行すべて bun）。

---

## 1. ゴールと非ゴール

### ゴール
- cppnes と機能等価なコアを TypeScript で実装する（Mapper 0/1/2/3/4/5/10/69/70）。
- **ブラウザで実機 ROM が遊べる**（Canvas 描画 + WebAudio 発音 + キーボード/ゲームパッド）。
- nestest ログ 8991 行一致、blargg 等のテスト ROM が cppnes と同じ合否。
- `.sav`（バッテリー）/ `.cht`（Game Genie）は gones / rsnes / cppnes と **バイト/書式互換**。
- セーブステートは cppnes と同じ LE 形式（マジック `RSST`）で **クロスロード可能**にする。

### 非ゴール
- PAL 対応（NTSC 固定）。未サポート Mapper の追加。ネットプレイ。
- Node.js 対応（bun 前提。ただしコアはランタイム非依存の純粋 TS）。

---

## 2. プロジェクト構成

```
tsnes/
├── package.json / tsconfig.json      # bun + strict TS
├── PLAN.md / README.md
├── src/
│   ├── core/                         # ランタイム非依存（DOM/bun API を一切使わない）
│   │   ├── index.ts                  # 公開 re-export
│   │   ├── savestate.ts  bus.ts  cpu.ts  ppu.ts  palette.ts  apu.ts
│   │   ├── cartridge.ts  mapper.ts  mapper/mapper{0,1,2,3,4,5,10,69,70}.ts
│   │   ├── input.ts  cheat.ts  nes.ts
│   └── web/                          # ブラウザフロントエンド
│       ├── index.html  main.ts  video.ts  audio.ts  input.ts  storage.ts
├── tests/                            # bun:test（ユニット + ROM 統合）
└── tools/                            # headless.ts（ROM 実行/PNG/WAV）, serve.ts, build.ts
```

- **コアは DOM にも bun にも依存しない**。ファイル I/O はフロント/ツール側の責務。
- テスト ROM は環境変数 `TSNES_TEST_ROMS`（既定 `R:\nes-test-roms-master`）、
  市販 ROM は `TSNES_GAME_ROMS`（既定 `R:\`）。不在ならテストは skip。ROM はコミットしない。

---

## 3. C++ → TypeScript 対応の指針

| C++ (cppnes) | TypeScript (tsnes) | 補足 |
|---|---|---|
| `uint8_t` / `uint16_t` | `number` + **明示マスク** `& 0xff` / `& 0xffff` | 最重要ハザード（第 5 章） |
| `int64_t cycles` | `number` | 2^53 まで安全。フレーム数・サイクル数に十分 |
| `std::array<uint8_t,N>` | `Uint8Array(N)` | |
| `std::vector<uint8_t>` | `Uint8Array` | 可変長が要る所のみ通常配列 |
| `std::vector<uint32_t>`（frame_buffer） | `Uint32Array` | 256×240 ARGB |
| `std::optional<Cartridge>` | `Cartridge \| null` | 未接続 = `null`（C++ の `nullptr` 引数に対応） |
| `std::unique_ptr<Mapper>` | `Mapper`（抽象クラス） | |
| 純粋仮想 `= 0` | `abstract` メソッド | |
| 既定実装つき仮想 | 基底クラスの通常メソッド | |
| `enum class` | `const` オブジェクト + union 型、または数値定数 | ホットパスは数値 |
| `std::expected<T, E>` | **例外**（`Error` サブクラス） | 構築境界のみ。ホットパスでは投げない |
| `switch` | `switch` | V8 もジャンプテーブル化する |
| `static_cast<uint8_t>(x)` | `x & 0xff` | |
| メソッド名 `snake_case` | **`snake_case` を維持** | cppnes/rsnes/gones との行単位トレーサビリティ最優先 |
| `friend struct PpuTestHook` | `/** @internal */` public フィールド | TS に private 突破は無い |
| f32 演算（APU フィルタ） | `Math.fround(...)` | **f32 精度の再現に必須**（第 5 章） |

### 命名規約
- クラス名は `PascalCase`（`Nes` / `Bus` / `Cpu` / `Ppu` / `Apu` / `Cartridge` / `Mapper`）。
- メソッド・フィールドは **cppnes と同名の `snake_case`**（`step_n` / `read_register` /
  `frame_buffer` / `cart_ptr`）。イディオムより移植の追跡可能性を優先する。
- 定数は cppnes と同じ `SCREAMING_SNAKE_CASE`（`FLAG_CARRY` / `PPUSTATUS_VBLANK`）。

---

## 4. フェーズ別マイルストーン（cppnes の Phase 構成に対応）

各 Phase は「テストを書く（Red）→ 通す（Green）→ リファクタ」。

| Phase | 内容 | 移植元 | 完了条件 |
|---|---|---|---|
| 0 | 足場（bun/tsconfig）、`savestate.ts`、`bus.ts` | savestate.hpp / bus.cpp | `bus_test` / `savestate_test` グリーン |
| 1 | 6502 公式命令 | cpu.cpp | `cpu_test` 公式分 + **nestest 8991 行一致** |
| 2 | 割り込み・非公式命令・OAM DMA | cpu.cpp | `cpu_interrupts_v2` 等が cppnes と同合否 |
| 3 | Cartridge + Mapper 基盤 + Mapper0 | cartridge.cpp / mapper.cpp | NROM ロード & 実行 |
| 4 | PPU + PaletteManager | ppu.cpp / palette.cpp | `ppu_vbl_nmi` 等 + 描画ハッシュ一致 |
| 5 | `Nes` 統合（駆動順の忠実移植） | nes.cpp | ヘッドレスでフレーム生成、cppnes と BMP 一致 |
| 6 | APU 5ch + フィルタ | apu.cpp | `apu_test` 等 + WAV 統計一致 |
| 7 | Mapper 1/2/3/4/5/10/69/70 | mapper/*.hpp | `mmc3_test` / `mmc5test` + 実機 ROM 起動 |
| 8 | 入力・チート・`.sav`・セーブステート | input/cheat.cpp | 往復一致、cppnes の `.state` 相互ロード |
| 9 | **ブラウザフロントエンド** | sdl/gui.cpp 相当 | 実機 ROM がブラウザで遊べる |
| 10 | 仕上げ（性能・README・全 ROM 回帰） | — | 60fps 維持、全スイート cppnes と同結果 |

### Phase 5 の駆動順（`Nes::step`、精度の心臓部・そのまま写す）
1. `cpu_cycles = cpu.step(bus)`
2. `$2000` 書きによる即時 NMI を `ppu.consume_nmi()` で捕捉
3. マッパー IRQ を `ppu.mapper_irq` に反映
4. NMI 配送パイプライン（`pending_nmi → trigger_nmi`、`nmi_delay → pending_nmi`）
5. `ppu.step_n(cpu_cycles * 3, cart)`
6. `apu.step_n(cpu_cycles, cart)`
7. `cart.tick_cpu(cpu_cycles)`（FME-7 等 CPU レートタイマ）
8. レベルトリガ IRQ の OR 合成 `cpu.irq = ppu.mapper_irq || apu.frame_irq || apu.dmc.interrupt_flag`
9. `cpu.poll_irq()`

---

## 5. 移植上のハザード（C++ → TypeScript 固有）

- **整数幅がない**: JS の数値は f64。`uint8_t` の自然な wrap が無いので、
  **加減算・シフトの直後に必ず `& 0xff` / `& 0xffff`** を置く。C++ 側の
  `static_cast<uint8_t>` / 暗黙の切り捨てをすべて明示マスクへ変換する（最重要）。
- **ビット演算は int32**: `x << 24` は符号付きになる。ARGB 生成は `>>> 0` で
  符号なしへ畳む（`Uint32Array` へ入れる場合は自動で切り捨てられるが、比較時に注意）。
- **f32 の再現**: C++ の `float` 演算（APU ミキサ/フィルタ、FME-7 音源）は
  `Math.fround()` を各演算ごとに適用して f32 の丸めを再現する。`double` はそのまま。
- **符号付き右シフト**: `>>` ではなく `>>>` を使う場面を C++ の型から判断する。
- **配列境界**: C++ の `i < v.size() ? v[i] : 0` は TS でも同じ明示チェック
  （`Uint8Array` の範囲外は `undefined` で NaN 汚染を起こすため必須）。
- **性能**: ホットパス（CPU R/W → Bus → PPU/APU/Mapper）は
  - オブジェクト形状を固定（コンストラクタで全フィールドを初期化、後から追加しない）
  - 小さい戻り値のタプル（`std::pair`）は **オブジェクト割り当てを避けて**
    「戻り値 + `this._page_crossed` 等のフィールド」へ分解する
  - `Uint8Array` / `Uint32Array` を使い、通常配列の hole を作らない

---

## 6. テスト戦略

1. **ユニット**（ROM 不要、`bun test`）: cppnes `core/tests/*.cpp` を 1:1 で移植。
2. **ROM 統合**: blargg プロトコル（`$6000` ステータス、マジック `DE B0 61`、`$6004-` テキスト）。
   `TSNES_TEST_ROMS` 不在なら skip。既知の expected-fail は cppnes と同じ扱い。
3. **黄金値**: フレームバッファのハッシュで描画回帰を検出。
4. **cppnes との差分**: nestest トレースログの行単位 diff、ヘッドレス実行の
   フレームバッファ PNG/ハッシュ比較、WAV 統計比較。

---

## 7. ブラウザフロントエンド（Phase 9）

- **描画**: `Canvas 2D` + `ImageData`（`Uint32Array` を直接 RGBA へ）。
  cppnes の frame_buffer は ARGB なので、`putImageData` 用に RGBA へ並べ替える
  （`framebuffer_rgba()` 相当をコア側に持つ）。将来 WebGL 化も可能な境界にする。
- **音声**: `AudioWorklet` + `SharedArrayBuffer` リングバッファ（不可なら
  `ScriptProcessor` フォールバック）。APU の `drain_output()` を毎フレーム流し込む。
- **タイミング**: `requestAnimationFrame` で `step_frame()` を駆動し、
  音声バッファ残量でフレームペースを微調整する（音声クロック同期）。
- **入力**: `keydown/keyup`（既定は cppnes と同じ Z/X/A/S/矢印）+ Gamepad API。
- **ROM 読み込み**: ファイル選択 + ドラッグ&ドロップ。`.sav` / セーブステートは
  IndexedDB に保存し、ダウンロード/アップロードで cppnes と交換可能にする。
- **配信**: `bun build --target=browser` でバンドル、`Bun.serve` で開発サーバ。
