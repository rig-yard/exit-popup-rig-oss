#!/usr/bin/env node
/*
  配信と管理画面、2つの wrangler 設定の `database_id` が一致していて、かつ仮の値ではないかを見る。
  違反があれば非ゼロで終わる。判定は `scripts/database-id-guard.mjs` の1本だけが持つ。
  両 wrangler 設定の `build.command` から呼ぶ(どちらを先に deploy してもこの検査を通る)。
  読む設定は `checkedConfigPaths()`(deploy の経路が渡した「実際に deploy する設定」。
  渡されなければ追跡中の設定)。

  🔴 **省略する経路は無い。** CI も `deploy.local.json` に CI 専用の値を書いて、この検査を
  そのまま通す(`.github/workflows/ci.yml` 参照)。
*/
import { databaseIdMismatchProblems } from "./database-id-guard.mjs";
import { checkedConfigPaths, readWranglerConfig } from "./wrangler-config.mjs";

const paths = checkedConfigPaths();
const delivery = readWranglerConfig(paths.delivery);
const admin = readWranglerConfig(paths.admin);

const deliveryDatabaseId = delivery.d1_databases?.[0]?.database_id;
const adminDatabaseId = admin.d1_databases?.[0]?.database_id;

const problems = databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId });

if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem.message}`);
  console.error("\ndeploy.local.json の databaseId に、自分の D1 の id を書いてください(docs/deploy.md §3)。");
  process.exit(1);
}

console.log(`OK  配信と管理画面の database_id が一致している(仮の値ではない)。`);
