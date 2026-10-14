#!/usr/bin/env node
/*
  `out/_headers` に CSP が無いまま deploy しようとしていないか、
  `NEXT_PUBLIC_DELIVERY_ORIGIN` が配信 Worker のホスト(`https://<配信の routes[0].pattern>`)と
  完全一致しているかを見る。違反があれば非ゼロで終わる。判定は `scripts/admin-headers-guard.mjs`
  (CSP の形)と `scripts/delivery-origin-guard.mjs`(配信元の一致)の2本だけが持つ
  (テストで「落ちる例」と「通る例」の両方を固定してある)。

  🔴 **省略する経路は無い。** `wrangler.admin.jsonc` の `build.command` から呼ぶ(deploy の直前に
  必ず走る)。配信側の設定がプレースホルダのままでも、ここでは配信元の一致だけを見る
  (プレースホルダの拒否は `check-custom-domain.mjs` が持つ)。

  手元で確かめるときは(`deploy.local.json` を書いたあと):
  npm run config:render && NEXT_PUBLIC_DELIVERY_ORIGIN=https://<配信のホスト> npm run build \
    && ADPOP_DELIVERY_CONFIG=wrangler.delivery.generated.jsonc node scripts/check-admin-headers.mjs
*/
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryOriginEmbeddedProblems, headersGuardProblems } from "./admin-headers-guard.mjs";
import { deliveryOriginGuardProblems, expectedDeliveryOrigin } from "./delivery-origin-guard.mjs";
import { checkedConfigPaths, readWranglerConfig } from "./wrangler-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "out");
const HEADERS_PATH = path.join(OUT_DIR, "_headers");
const NEXT_DIR = path.join(OUT_DIR, "_next");

let headersContent;
try {
  headersContent = readFileSync(HEADERS_PATH, "utf8");
} catch {
  console.error(`NG  ${HEADERS_PATH} が無い(先に npm run build を実行してください)`);
  process.exit(1);
}

const deliveryOrigin = (process.env.NEXT_PUBLIC_DELIVERY_ORIGIN ?? "").replace(/\/$/, "");
const expectedOrigin = expectedDeliveryOrigin(readWranglerConfig(checkedConfigPaths().delivery).routes?.[0]?.pattern);

/** `dir` 以下の `.js` ファイルの中身を全部集める(ビルドのチャンク名はハッシュ付きで固定できないため)。 */
function collectJsContents(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let contents = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) contents = contents.concat(collectJsContents(full));
    else if (entry.name.endsWith(".js")) contents.push(readFileSync(full, "utf8"));
  }
  return contents;
}

const problems = [
  ...headersGuardProblems({ headersContent, deliveryOrigin }),
  ...deliveryOriginEmbeddedProblems({ deliveryOrigin, fileContents: collectJsContents(NEXT_DIR) }),
  ...deliveryOriginGuardProblems({ actualOrigin: deliveryOrigin, expectedOrigin }),
];

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`NG  ${problem}`);
  }
  console.error(`\n${HEADERS_PATH} / out/_next は、確定した配信元を含めて正しくビルドされた形になっていません。`);
  console.error(`配信の Worker のホスト(https://<host>)を NEXT_PUBLIC_DELIVERY_ORIGIN に渡して npm run build をやり直してください。`);
  process.exit(1);
}

console.log(`OK  ${HEADERS_PATH} に CSP・X-Content-Type-Options・X-Frame-Options・Referrer-Policy があり、`);
console.log(`OK  配信元(${deliveryOrigin})が img-src とビルド出力の両方に入っている。`);
