/*
  `wrangler.*.jsonc` を読む共通ユーティリティ(JSON コメント以外は書き換えない)。
  `tests/helpers/wrangler-config.ts` と、deploy 前の検査(`scripts/check-*.mjs`)の両方が
  この1本だけを使う(読み方を2つ持たない)。
  ⚠ ブロックコメント(/* *\/)は使っていないので扱わない(使ったら JSON.parse が落ちて気づける)。
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DELIVERY_WRANGLER_PATH = path.join(REPO_ROOT, "wrangler.delivery.jsonc");
export const ADMIN_WRANGLER_PATH = path.join(REPO_ROOT, "wrangler.admin.jsonc");

/**
 * 検査が読む設定ファイルのパス。deploy の経路(`scripts/guarded-deploy.mjs`)は、実際に deploy する
 * 設定の書き出し先を環境変数で渡す。渡されていなければ、追跡している設定そのものを読む
 * (`wrangler deploy -c wrangler.admin.jsonc` を直接打っても、プレースホルダのままなら検査が落ちる)。
 */
export const DELIVERY_CONFIG_ENV = "ADPOP_DELIVERY_CONFIG";
export const ADMIN_CONFIG_ENV = "ADPOP_ADMIN_CONFIG";
export function checkedConfigPaths(env = process.env) {
  return {
    delivery: env[DELIVERY_CONFIG_ENV] || DELIVERY_WRANGLER_PATH,
    admin: env[ADMIN_CONFIG_ENV] || ADMIN_WRANGLER_PATH,
  };
}

export function stripLineComments(source) {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

export function readWranglerConfig(file) {
  return JSON.parse(stripLineComments(readFileSync(file, "utf8")));
}
