#!/usr/bin/env node
/*
  生成した設定(`deploy.local.json` を重ねたもの)で wrangler の補助コマンドを打つ。
  `npm run wrangler:delivery -- d1 time-travel info adpop` のように使う(ローカル確認は `dev`・`d1 ... --local`。`npm run delivery:dev` などが呼ぶ)。毎回その場で設定を作り直す
  (`deploy.local.json` が無い・壊れているときは作らずに止まる)。引数の判定は `scripts/wrangler-run-guard.mjs`。
*/
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { guardEnv, renderGeneratedConfigs } from "./deploy-config.mjs";
import { localDeliveryOrigin, localWranglerConfig, usesLocalConfig } from "./local-dev.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, REPO_ROOT, readWranglerConfig } from "./wrangler-config.mjs";
import { wranglerRunProblems } from "./wrangler-run-guard.mjs";

const TRACKED_PATHS = { delivery: DELIVERY_WRANGLER_PATH, admin: ADMIN_WRANGLER_PATH };

const [target, ...args] = process.argv.slice(2);

const problems = wranglerRunProblems({ target, args });
if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  process.exit(1);
}

let rendered;
try {
  rendered = renderGeneratedConfigs();
} catch (error) {
  console.error(`NG  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let configPath = rendered[target];
let env = guardEnv(rendered);
// dev とローカルの D1 操作は、本番を指せる値を持たない設定を使う(scripts/local-dev.mjs)
if (usesLocalConfig(args)) {
  configPath = path.join(REPO_ROOT, `wrangler.${target}.local.generated.jsonc`);
  writeFileSync(configPath, JSON.stringify(localWranglerConfig(readWranglerConfig(TRACKED_PATHS[target]), target), null, 2) + "\n");
}
// admin dev は、ローカルの配信 Worker の URL を配信元にする
if (target === "admin" && args[0] === "dev") {
  try {
    env = { ...env, NEXT_PUBLIC_DELIVERY_ORIGIN: localDeliveryOrigin(process.env) };
  } catch (error) {
    console.error(`NG  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// dev の待ち受けポートの既定値(渡されていなければ。配信 8787 と管理画面 8788 を分ける)
const wranglerArgs = [...args];
if (args[0] === "dev" && !args.some((arg) => String(arg).split("=")[0] === "--port")) {
  wranglerArgs.push("--port", target === "admin" ? "8788" : "8787");
}

const result = spawnSync("npx", ["wrangler", ...wranglerArgs, "-c", configPath], { stdio: "inherit", env });
process.exit(result.status ?? 1);
