#!/usr/bin/env node
/*
  `deploy.local.json` を重ねた `wrangler.*.generated.jsonc` を作る(`npm run config:render`)。
  設定の中身を確かめたいときに使う。deploy・migrate:remote・wrangler:*・admin:hash は、毎回自分で
  同じ生成をするので、先にこれを打つ必要は無い。生成した設定を `wrangler` に直接渡さない
  (古い生成物を使ってしまう)。補助コマンドは `npm run wrangler:delivery|admin -- <引数>` で打つ。
*/
import { renderGeneratedConfigs } from "./deploy-config.mjs";

try {
  const { delivery, admin } = renderGeneratedConfigs();
  console.log("OK  deploy.local.json を重ねて書き出した:");
  console.log(`    ${delivery}\n    ${admin}`);
} catch (error) {
  console.error(`NG  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
