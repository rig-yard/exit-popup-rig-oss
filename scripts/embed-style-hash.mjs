/*
  管理画面のプレビューが Shadow DOM に差し込む `packages/embed/src/popup-view.ts`
  の `STYLE` 定数を、**ビルド時に実物のソースから取り出す**(手で書き写さない)。

  🔴 `build-admin-headers.mjs` は素の Node スクリプト(`node scripts/build-admin-headers.mjs`)で、
    TypeScript をそのまま import できない。`scripts/embed-build.mjs` と同じ esbuild を使い、
    `popup-view.ts` を ESM としてバンドルし、一時ファイルへ書き出して `import()` する。
*/
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./embed-build.mjs";

/** `popup-view.ts` の `STYLE`(文字列そのまま)を返す。 */
export async function loadEmbedStyle() {
  const result = await build({
    entryPoints: ["packages/embed/src/popup-view.ts"],
    bundle: true,
    format: "esm",
    write: false,
    minify: false,
    target: ["es2019"],
    logLevel: "silent",
    absWorkingDir: REPO_ROOT,
  });
  const code = result.outputFiles[0].text;
  const dir = mkdtempSync(path.join(os.tmpdir(), "adpop-embed-style-"));
  const file = path.join(dir, "popup-view.mjs");
  writeFileSync(file, code);
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.STYLE !== "string") {
      throw new Error("popup-view.ts の STYLE を取り出せなかった(export の形が変わっていないか確認してください)");
    }
    return mod.STYLE;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
