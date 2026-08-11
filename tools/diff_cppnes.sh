#!/usr/bin/env bash
# cppnes との差分検証: 同じ ROM を同じフレーム数だけヘッドレス実行し、
# 出力 BMP（フレームバッファ）と報告サイクル数をバイト比較する。
#
#   tools/diff_cppnes.sh [frames] [rom...]
# ROM 引数が無ければ R:/nes-test-roms-master 以下の代表 ROM を総当たりする。
set -u

FRAMES="${1:-200}"
shift || true

CPPNES="${CPPNES_EXE:-/c/Users/YoshioMiyamae/repos/cppnes/build/sdl/cppnes.exe}"
# 実行ごとに独立した作業ディレクトリを使う（並行実行しても互いの
# スクリーンショット/ROM コピーを踏まない）。
OUT="${TMPDIR:-/tmp}/tsnes-diff-$$"
WORK="$OUT/work"
mkdir -p "$WORK"
trap 'rm -rf "$OUT"' EXIT

if [ "$#" -gt 0 ]; then
  ROMS=("$@")
else
  # 空白を含むファイル名があるので NUL 区切りで受け取る。
  mapfile -d '' -t ROMS < <(find "${TSNES_TEST_ROMS:-R:/nes-test-roms-master}" -name '*.nes' -print0 | sort -z)
fi

pass=0; fail=0; skip=0
for rom in "${ROMS[@]}"; do
  name=$(basename "$rom")
  # 両エミュレータは終了時に ROM の隣へ .sav を書き出すため、一方の実行結果が
  # もう一方の初期状態を汚染する。ROM を作業ディレクトリへ複製し、そのコピーに
  # 対して両者を走らせることで、元の ROM ディレクトリには一切触れずに隔離する。
  # （作業ディレクトリ自体は作り直さない — Windows の遅延削除と競合するため）
  rm -f "$WORK"/*
  cp "$rom" "$WORK/$name" || { echo "COPY-FAILED $name"; fail=$((fail+1)); continue; }
  cpp_out=$("$CPPNES" --headless --frames "$FRAMES" --screenshot "$OUT/cpp.bmp" "$WORK/$name" 2>&1)
  # cpp が書いた .sav を消し、ts も「バッテリー空」から始める。
  find "$WORK" -name '*.sav' -delete
  ts_out=$(bun run tools/headless.ts --headless --frames "$FRAMES" --screenshot "$OUT/ts.bmp" "$WORK/$name" 2>&1)
  cpp_cyc=$(echo "$cpp_out" | grep -o 'cycles=[0-9]*' | head -1)
  ts_cyc=$(echo "$ts_out" | grep -o 'cycles=[0-9]*' | head -1)
  if [ -z "$cpp_cyc" ] || [ -z "$ts_cyc" ]; then
    # 両者ともロード失敗なら想定内（未対応マッパー等）。
    if [ -z "$cpp_cyc" ] && [ -z "$ts_cyc" ]; then
      skip=$((skip+1))
    else
      echo "LOAD-MISMATCH $name (cpp='$cpp_out' ts='$ts_out')"
      fail=$((fail+1))
    fi
    continue
  fi
  if [ "$cpp_cyc" != "$ts_cyc" ]; then
    echo "CYCLE-MISMATCH $name cpp=$cpp_cyc ts=$ts_cyc"
    fail=$((fail+1))
    continue
  fi
  if cmp -s "$OUT/cpp.bmp" "$OUT/ts.bmp"; then
    pass=$((pass+1))
  else
    echo "FB-MISMATCH $name ($cpp_cyc)"
    fail=$((fail+1))
  fi
done

echo "----"
echo "identical: $pass  mismatched: $fail  skipped(both failed to load): $skip  frames=$FRAMES"
[ "$fail" -eq 0 ]
