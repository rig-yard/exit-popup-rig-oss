/*
  `npm run wrangler:delivery -- <引数>` / `npm run wrangler:admin -- <引数>` が受ける引数の判定(純粋関数)。
  生成した設定(`deploy.local.json` を重ねたもの)で wrangler の補助コマンド(Time Travel・PRAGMA optimize・
  secret の登録・ローカルの dev など)を打つための入口。毎回その場で設定を作り直すので、古い設定や未生成の設定は使われない。

  deploy はここから打てない(deploy は `npm run deploy:*` だけ。検査を通る経路を1本に保つため)。
  設定ファイルや Worker 名を引数で差し替えることも断る。
*/
export const WRANGLER_RUN_TARGETS = ["delivery", "admin"];

/** 最初の引数に使える wrangler のコマンド。deploy・delete・publish などは含めない。 */
export const ALLOWED_COMMANDS = ["d1", "secret", "dev"];

const REMOTE_FLAGS = ["--remote", "-r"];

const FORBIDDEN_FLAGS = ["-c", "--config", "--env", "-e", "--name"];

export function wranglerRunProblems({ target, args }) {
  if (!WRANGLER_RUN_TARGETS.includes(target)) {
    return [`使い方: node scripts/wrangler-run.mjs <${WRANGLER_RUN_TARGETS.join("|")}> <wrangler の引数>(渡された値: ${JSON.stringify(target)})`];
  }
  const problems = [];
  if (!Array.isArray(args) || !ALLOWED_COMMANDS.includes(args[0])) {
    problems.push(`ここから打てる wrangler のコマンドは ${ALLOWED_COMMANDS.join("・")} だけ(渡された値: ${JSON.stringify(args?.[0])})。deploy は npm run deploy:${target}`);
  }
  // dev は手元で立てるためのもの。--remote は実リソースを使う経路になるので、ここからは開かない
  if (args?.[0] === "dev" && (args ?? []).some((arg) => REMOTE_FLAGS.includes(String(arg).split("=")[0]) || /^-[a-zA-Z]*r[a-zA-Z]*$/.test(String(arg)))) {
    problems.push("dev に --remote(-r)は渡せない(ローカルの確認用)");
  }
  for (const arg of args ?? []) {
    const flag = String(arg).split("=")[0];
    if (FORBIDDEN_FLAGS.includes(flag)) problems.push(`設定や Worker 名を差し替える引数は渡せない: ${arg}`);
  }
  return problems;
}
