// ROM ベース統合テスト共通ヘルパー（移植元 cppnes `core/tests/common.hpp`）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// テスト ROM の基点ディレクトリ。環境変数 TSNES_TEST_ROMS を優先、無ければ
// R:\nes-test-roms-master。どちらも無ければ null（呼び出し側は skip）。
export function test_roms_dir(): string | null {
  const env = process.env.TSNES_TEST_ROMS;
  if (env && is_dir(env)) return env;
  const fallback = "R:/nes-test-roms-master";
  if (is_dir(fallback)) return fallback;
  return null;
}

// 市販 ROM とコンパニオン置き場。TSNES_GAME_ROMS、無ければ R:\。
export function game_roms_dir(): string | null {
  const env = process.env.TSNES_GAME_ROMS;
  if (env && is_dir(env)) return env;
  const fallback = "R:/";
  if (is_dir(fallback)) return fallback;
  return null;
}

function is_dir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function read_file(...parts: string[]): Uint8Array | null {
  const path = join(...parts);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}
