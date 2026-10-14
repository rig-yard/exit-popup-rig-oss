#!/usr/bin/env node
/*
  `npm run deploy:delivery` / `npm run deploy:admin` が呼ぶ、唯一の正規 deploy 経路。
  判定(追加の CLI 引数を受け付けない理由)は `scripts/deploy-args-guard.mjs` を見てください。

  使い方:
    node scripts/guarded-deploy.mjs delivery
    node scripts/guarded-deploy.mjs admin
*/
import { spawnSync } from "node:child_process";
import { deployArgsGuardProblems } from "./deploy-args-guard.mjs";
import { guardEnv, renderGeneratedConfigs } from "./deploy-config.mjs";

const target = process.argv[2];
const extraArgs = process.argv.slice(3);

const problems = deployArgsGuardProblems({ target, extraArgs });
if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  process.exit(1);
}

// `deploy.local.json` を重ねた設定を作り(無ければここで止まる)、その設定で deploy する。
// deploy 前の検査(build.command から呼ばれる)にも同じファイルを環境変数で渡し、
// 「検査した設定」と「deploy する設定」を同じものにする。
let rendered;
try {
  rendered = renderGeneratedConfigs();
} catch (error) {
  console.error(`NG  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const env = guardEnv(rendered);

const result = spawnSync("npx", ["wrangler", "deploy", "-c", rendered[target]], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
