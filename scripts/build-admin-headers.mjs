#!/usr/bin/env node
/*
  管理画面の `out/_headers` を、**ビルド後の実物の HTML から**作る。
  `npm run build`(= build:embed && next build && build:admin-headers)の最後に走る。

  🔴 `_headers` は Cloudflare の静的配信にしか効かない(`/api/*` は Worker のコードが先に走る。
    Hono 側のヘッダは src/admin/app.ts のミドルウェアが持つ)。
  🔴 配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)の値はそのまま信じない。ワイルドカード・非 https を
    含む値は img-src に入れない(fail-closed。設定ミスで CSP が緩むより、サムネイルが出ない方を選ぶ)。
*/
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCsp, collectScriptHashes, scriptHashToken } from "./csp.mjs";
import { loadEmbedStyle } from "./embed-style-hash.mjs";
import { isLocalOrigin } from "./local-dev.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_OUT_DIR = path.join(REPO_ROOT, "out");

/**
 * `https://host` または `https://host:port` の形を許す(ワイルドカード・パス・クエリは断る)。
 * ローカル確認用に `http://localhost:<port>` / `http://127.0.0.1:<port>` も許す(`npm run admin:dev`)。
 * deploy 前の検査(`check-admin-headers.mjs`)は配信元が `https://<配信ホスト>` と完全一致しなければ止めるので、
 * ここで許してもローカルの URL では deploy まで進めない。
 */
export function isSafeOrigin(value) {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value) || isLocalOrigin(value);
}

/**
 * `out/_headers` の中身を組み立てる(純粋関数。実際のファイル I/O は `main()` だけが持つ)。
 * `/*` の1ルールに全ヘッダをまとめる(管理画面はページ数が少なく、見込みの文字数は上限
 * 〈100 ルール・1行 2,000 文字〉に収まる)。
 * @param {{ htmlContents: string[], deliveryOrigin: string | null | undefined, styleHashes?: string[] }} params
 */
export function buildAdminHeadersFile({ htmlContents, deliveryOrigin, styleHashes = [] }) {
  const scriptHashes = collectScriptHashes(htmlContents);
  const origin = deliveryOrigin && isSafeOrigin(deliveryOrigin) ? deliveryOrigin : null;
  const csp = buildCsp({ scriptHashes, styleHashes, deliveryOrigin: origin });
  return [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "",
  ].join("\n");
}

async function main() {
  let files;
  try {
    files = readdirSync(ADMIN_OUT_DIR).filter((f) => f.endsWith(".html"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(`out/ に .html が無い(先に next build を実行してください): ${ADMIN_OUT_DIR}`);
  }
  const htmlContents = files.map((f) => readFileSync(path.join(ADMIN_OUT_DIR, f), "utf8"));
  const deliveryOrigin = (process.env.NEXT_PUBLIC_DELIVERY_ORIGIN ?? "").replace(/\/$/, "");
  // 🔴 プレビューが Shadow DOM に差し込む STYLE のハッシュ。手で書き写さず、
  //   ビルドのたびに実物の popup-view.ts から数える(embed-style-hash.mjs 参照)。
  const embedStyle = await loadEmbedStyle();
  const styleHashes = [scriptHashToken(embedStyle)];
  const content = buildAdminHeadersFile({ htmlContents, deliveryOrigin, styleHashes });
  writeFileSync(path.join(ADMIN_OUT_DIR, "_headers"), content);
  console.log(`OK  out/_headers (${files.length} 件の .html からインラインscriptのハッシュを数えた。style-srcにプレビューのハッシュ1件を追加)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
