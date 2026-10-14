#!/usr/bin/env node
/*
  本番の D1 にマイグレーションを当てる(`npm run migrate:remote`)。
  追跡している `wrangler.*.jsonc` の database_id はプレースホルダなので、`wrangler d1 migrations apply`
  を直接打たず、`deploy.local.json` を重ねた設定で当てる。プレースホルダのままなら当てずに止まる。
  何も受け付けない(追加の引数なし)。
*/
import { spawnSync } from "node:child_process";
import { databaseIdMismatchProblems } from "./database-id-guard.mjs";
import { renderGeneratedConfigs } from "./deploy-config.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

if (process.argv.length > 2) {
  console.error("NG  追加の引数は受け付けない(npm run migrate:remote)");
  process.exit(1);
}

let rendered;
try {
  rendered = renderGeneratedConfigs();
} catch (error) {
  console.error(`NG  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const problems = databaseIdMismatchProblems({
  deliveryDatabaseId: readWranglerConfig(rendered.delivery).d1_databases?.[0]?.database_id,
  adminDatabaseId: readWranglerConfig(rendered.admin).d1_databases?.[0]?.database_id,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem.message}`);
  process.exit(1);
}

const result = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "adpop", "--remote", "-c", rendered.admin], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
