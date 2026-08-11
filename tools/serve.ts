// 開発サーバ（Bun.serve）。TypeScript はリクエスト時にバンドルして返す。
//
//   bun run dev   → http://localhost:5173
import { resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 5173);
// 動作確認用に ROM ディレクトリを配信する（?rom=/rom/<相対パス> で自動起動）。
const ROM_DIR = process.env.TSNES_TEST_ROMS ?? "R:/nes-test-roms-master";
// 配信パス → バンドルするエントリポイント。
const BUNDLES: Record<string, string> = {
  "/main.js": "src/web/main.ts",
  "/audio-worklet.js": "src/web/audio-worklet.ts",
};

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    define: { __TSNES_DEV__: "true" },
  });
  if (!result.success) {
    const msg = result.logs.map(String).join("\n");
    return `document.body.textContent = ${JSON.stringify(`build error:\n${msg}`)};`;
  }
  return await result.outputs[0]!.text();
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file("src/web/index.html"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const entry = BUNDLES[url.pathname];
    if (entry !== undefined) {
      return new Response(await bundle(entry), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/rom/")) {
      // ROM_DIR の外へ出るパス（`..` 等）は拒否する。
      const root = resolve(ROM_DIR);
      const path = resolve(root, decodeURIComponent(url.pathname.slice(5)));
      if (path !== root && !path.startsWith(root + sep)) {
        return new Response("forbidden", { status: 403 });
      }
      const file = Bun.file(path);
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response("rom not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`tsnes dev server: http://localhost:${server.port}`);
