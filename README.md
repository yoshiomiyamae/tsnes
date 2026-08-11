# tsnes

`../cppnes`（C++23 製 NES エミュレータ。その先は Rust の `../rsnes` → Go の `../gones`）の
**TypeScript 移植**。**ブラウザで動作**する。設計・移植方針は [PLAN.md](PLAN.md)。

cppnes を「正解」とし、同じユニットテスト・同じテスト ROM 群に加えて、
**cppnes とのヘッドレス出力バイナリ差分**（フレームバッファ + サイクル数）で
挙動の同一性を検証している。

- **CPU**: 6502（公式 + 非公式命令、サイクル精度）— nestest 全 8991 行一致
- **PPU**: スキャンライン描画、スプライト0ヒット、スクロール、VBL/NMI レース、MMC3 A12 IRQ
- **APU**: 5ch（矩形x2 / 三角 / ノイズ / DMC）+ フレームシーケンサ + アナログ風フィルタ
  （`Math.fround` で C++ の `float` 演算を再現）
- **Mapper**: 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3), 5 (MMC5), 10 (MMC4),
  69 (FME-7 + 拡張音源), 70
- **ブラウザ**: Canvas 描画 + AudioWorklet 発音 + キーボード/ゲームパッド入力 +
  ROM ドラッグ&ドロップ + セーブステート（localStorage / ファイル書き出し）
- **チート編集パネル**（Ctrl+H）: Game Genie / `AAAA:VV[:CC]` を追加、個別 ON/OFF、
  削除、一括 ON/OFF、`.cht` 書き出し。localStorage に ROM ごと保存
- **RAM / レジスタビューア**（Ctrl+M）: CPU/PPU/APU レジスタ + ヘックスダンプ。
  変化バイト/チート作用中を色分けし、**16 進セルをクリックして値を書き換えられる**
  （cppnes の SDL ビューアの移植 + 編集機能）
- **互換**: `.sav`（バッテリー）は gones / rsnes / cppnes と**バイト互換**、
  `.cht`（Game Genie）は書式互換、セーブステートは cppnes と同形式（マジック `RSST`）

## 必要なもの

**bun** のみ（テスト・バンドル・ヘッドレス実行すべて bun）。

```bash
bun install
```

## ブラウザで動かす

```bash
bun run dev     # http://localhost:5173
```

ブラウザで開き、`.nes` ファイルを選ぶかウィンドウにドロップする。
音声はブラウザの自動再生制限のため、**画面を一度クリック**すると鳴り始める。

静的ファイルとして配布する場合:

```bash
bun run build   # dist/index.html + dist/main.js + dist/audio-worklet.js
```

`dist/` をそのまま任意の静的ホスティングに置けば動く（サーバ側の処理は不要）。

### RAM / レジスタビューア

`Ctrl+M` で開閉する。上段に CPU/PPU/APU のレジスタ、下段に 16 バイト/行の
ヘックスダンプ（2KB/画面 = 2 パネル）。`<` `>` で領域を切り替える
（WRAM `$0000-$07FF` / PRG-RAM `$6000-` を 2KB ごとページ送り）。

色分けは cppnes と同じ意味論:

| 表示 | 意味 |
|------|------|
| 暗い灰 | 値が `00` |
| 赤 | 前回描画から変化した |
| 明シアン | チートが読み値をすり替え中（表示値はすり替え後） |
| 深いシアン | チート登録はあるが実体値と一致 |

**16 進セルをクリックすると編集モード**になり、16 進 2 桁を打ち込むと
その場で書き換わる（矢印キーで移動、`Esc` で取り消し）。編集中はゲーム入力を
止めるので、方向キーがゲームへ漏れない。読み書きとも副作用のない経路
（`bus.ram` / `cartridge.save_ram()`）を直接触るので、マッパーの書き込み保護や
open bus の影響を受けない。

### チート編集パネル

`Ctrl+H` で開閉する。cppnes の GUI は `.cht` の読み直しと一括 ON/OFF だけだが、
ブラウザでは一覧から個別に編集できる（デコーダ・パーサ・`CheatManager` は
コアの移植をそのまま使う）。

- 入力欄に **Game Genie コード**（`SXIOPO` / `GZEEAPNL`）か
  **raw poke** `AAAA:VV[:CC]`（`0010:42`, `00FF:12:34`）を入れて「追加」
- 各行のチェックボックスで**個別に有効/無効**、「削除」で 1 件消す
- 「全体: 有効/無効」で一括切替（cppnes の `Ctrl+H` 相当）
- 「.cht を書き出す」でファイル保存。形式は gones / rsnes / cppnes と互換なので
  デスクトップ版と交換できる。`.cht` をウィンドウにドロップすれば読み込む
- 変更は ROM 名ごとに localStorage へ自動保存され、次回同じ ROM で復元される

RAM ビューアと連動していて、チートが効いている番地は明シアンで
**すり替え後の値**が表示される。

### 操作（既定）

| キー | 動作 | キー | 動作 |
|------|------|------|------|
| Z / X | A / B | Tab | ターボ（早送り） |
| A / S | Select / Start | Ctrl+R | リセット |
| 矢印 | 十字キー | F1–F10 | ステート保存（スロット 1–10） |
| M | 音声ミュート | Ctrl+F1–F10 | ステートロード |
| P | 一時停止 / 再開 | 8 | スプライト制限解除（ちらつき除去） |
| Ctrl+M | RAM / レジスタビューア | &lt; / &gt; | ビューアの表示領域切替 |

**ゲームパッド**（最大 2P）: Gamepad API で自動認識。1 台目→1P、2 台目→2P。
A→A、B→B、Back→Select、Start→Start、D-pad/左スティック→方向キー、
L2 を押している間だけターボ状態を反転（cppnes と同じ）。

`?rom=<URL>` を付けて開くと、その URL の ROM を自動で読み込む（**同一オリジンのみ**）。
開発サーバは `TSNES_TEST_ROMS` 以下を `/rom/<相対パス>` で配信する。
デバッグ用の `window.tsnes` フックは開発ビルドのみで、`bun run build` の
配布ビルドでは除去される。

## テスト

```bash
bun test              # ユニット + ROM 統合
bun run typecheck     # ルート + コア専用プロジェクトの 2 段階
```

`bun run typecheck` はルートの `tsconfig.json` に加えて `src/core/tsconfig.json`
（`lib: ESNext` のみ、`types` 無し）も検査する。これにより「コアは DOM にも
bun/node API にも依存しない」という PLAN.md の不変条件が型検査で担保される
（コアに `document` や `Bun.file` を書くとビルドが落ちる）。

ROM ベースのテスト（nestest / blargg / 描画ハッシュ / 互換 / smoke）は環境変数
`TSNES_TEST_ROMS`（既定 `R:/nes-test-roms-master`）と `TSNES_GAME_ROMS`（既定 `R:/`）を
見て、ROM 不在なら自動 skip する。著作権 ROM はコミットしない。

### cppnes との差分検証

同じ ROM を同じフレーム数だけ両者でヘッドレス実行し、フレームバッファ（BMP）と
サイクル数をバイト比較する。**nes-test-roms の全 263 本で完全一致**を確認済み。

```bash
bash tools/diff_cppnes.sh 60          # 既定の ROM 群を総当たり
bash tools/diff_cppnes.sh 200 rom.nes # ROM とフレーム数を指定
```

`CPPNES_EXE` で cppnes 実行ファイルの場所を指定できる
（既定 `../cppnes/build/sdl/cppnes.exe`）。

### 既知の失敗（cppnes と同一）

移植元の設計（命令単位ステッピング、未実装の不安定命令）に由来するもので、
いずれも cppnes と**フレームバッファまで同一**であることを差分検証済み。

| テスト | 理由 |
|--------|------|
| `ppu_vbl_nmi` 07 / 10 | 命令単位ステッピングではサイクル境界の NMI 判定に届かない |
| `instr_test-v5` 07-abs_xy | 不安定命令 SYA/SXA（$9C/$9E）未実装 |
| `cpu_interrupts_v2` 2/3/4/5 | 割り込みのサイクル単位タイミング |
| `mmc3_test` 6-MMC6 | MMC6/NEC-MMC3 変種（Sharp MMC3 と衝突） |

## ヘッドレス実行

cppnes と**同じ CLI・同じ出力バイト列**（BMP / WAV）:

```bash
bun run tools/headless.ts --headless --frames 250 --screenshot out.bmp <rom.nes>
bun run tools/headless.ts --headless --frames 700 --wav out.wav <rom.nes>
```

## パフォーマンス

BladeBuster.nes を 600 フレーム、ヘッドレス実行（bun / Windows）:

| 実装 | 実行時間 | 実時間比 |
|------|----------|----------|
| tsnes (bun) | 約 2.3 秒 | 約 4.8 倍（約 290 fps 相当） |
| cppnes (Debug) | 約 0.7 秒 | 約 14 倍 |

ブラウザ（Chrome）でも 60fps を安定して維持する。

## 構成

```
src/core/    エミュレータ本体（DOM にも bun にも依存しない純粋 TS。専用 tsconfig で強制）
src/web/     ブラウザフロントエンド（Canvas / AudioWorklet / 入力 / 永続化）
             audio-worklet.ts は独立エントリポイントとしてビルドされる
tests/       bun:test（cppnes の core/tests/*.cpp を 1:1 移植）
tools/       headless.ts（ヘッドレス実行）, diff_cppnes.sh（差分検証）, serve.ts, build.ts
```

コア側のメソッド名は移植の追跡性を優先して cppnes / rsnes / gones と同じ
`snake_case` を維持している（`step_n` / `read_register` / `frame_buffer` など）。

## ライセンス

MIT
