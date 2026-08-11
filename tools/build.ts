// ブラウザ向けバンドル（bun build）。出力は dist/。
import { cpSync, mkdirSync, rmSync } from "node:fs";

const outdir = "dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/web/main.ts", "src/web/audio-worklet.ts"],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  naming: "[dir]/[name].js",
  // 配布ビルドではデバッグ用フック（window.tsnes）を落とす。
  define: { __TSNES_DEV__: "false" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync("src/web/index.html", `${outdir}/index.html`);
console.log(`built ${result.outputs.length} file(s) -> ${outdir}/`);
