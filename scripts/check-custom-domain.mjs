#!/usr/bin/env node
/*
  両 Worker が Custom Domain(workers_dev: false・zone の routes を使わない・素のホスト名1件で
  プレースホルダではない)で受けているかを見る。違反があれば非ゼロで終わる。判定は
  `scripts/custom-domain-guard.mjs` の1本だけが持つ。両 wrangler 設定の `build.command` から呼ぶ
  (どちらの Worker を先に deploy してもこの検査が走る)。読む設定は `checkedConfigPaths()`
  (deploy の経路が渡した「実際に deploy する設定」。渡されなければ追跡中の設定)。

  🔴 **この検査自体を素通りさせるフラグ・環境変数は無い。** ただし渡せる環境変数は「どの設定を
  検査するか」のパスだけで、`npm run deploy:*` は deploy する設定と同じファイルを渡す。
  ⚠ **この検査が見ているのは設定ファイルの値だけ。** `wrangler deploy --route`/`--domain` 等の
  CLI 引数は、設定ファイルの `routes` とは別に、実際に deploy される routes を変えてしまう
  (`scripts/deploy-args-guard.mjs` を見てください)。正規の deploy 経路(`npm run deploy:delivery` /
  `npm run deploy:admin`)を使わず `wrangler deploy` を直接呼べば、この検査が合格した後に、検査が
  見ていない routes で実際には deploy できる。
*/
import { customDomainRouteProblems, distinctHostProblems, workersDevDisabledProblems } from "./custom-domain-guard.mjs";
import { checkedConfigPaths, readWranglerConfig } from "./wrangler-config.mjs";

const paths = checkedConfigPaths();
const delivery = readWranglerConfig(paths.delivery);
const admin = readWranglerConfig(paths.admin);

const problems = [
  ...workersDevDisabledProblems({ label: "配信", workersDev: delivery.workers_dev }),
  ...workersDevDisabledProblems({ label: "管理画面", workersDev: admin.workers_dev }),
  ...customDomainRouteProblems({ label: "配信", routes: delivery.routes }),
  ...customDomainRouteProblems({ label: "管理画面", routes: admin.routes }),
  ...distinctHostProblems({ deliveryHost: delivery.routes?.[0]?.pattern, adminHost: admin.routes?.[0]?.pattern }),
];

if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  console.error(
    "\n両 Worker の routes(custom_domain: true のホスト名1件だけ)・workers_dev: false を確認してください(docs/deploy.md)。",
  );
  process.exit(1);
}

console.log(`OK  配信・管理画面とも Custom Domain(workers_dev: false・zone の routes 無し)で受けている。`);
