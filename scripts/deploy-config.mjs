/*
  デプロイ先ごとの値(ドメイン・D1 の id)を、git に入れないファイル `deploy.local.json` から読み、
  追跡している `wrangler.*.jsonc`(プレースホルダだけが入っている)に重ねて、実際に deploy する
  設定ファイル(`wrangler.*.generated.jsonc`。.gitignore 済み)を作る。判定はこのファイルの純粋関数が持つ。

  `deploy.local.json` の形(3つの鍵だけ。他の鍵があれば typo として落とす):
    { "deliveryHost": "adpop.example.net", "adminHost": "adpop-admin.example.net",
      "databaseId": "<wrangler d1 create の出力の database_id>" }

  - `deploy.local.json` が無ければ、設定は作らず止まる(deploy・migrate:remote・admin:hash が全部止まる)。
  - 追跡している `wrangler.*.jsonc` に仮の値以外(自分のドメイン・D1 の id)が入っていても止まる。
    自分の値は追跡ファイルに書かず、必ず `deploy.local.json` に書く。
  - ホスト名は DNS と同じく大文字小文字を区別しない。比べる前に、必ず `normalizeHost` を通す。
  - 上書きするのは `routes[0].pattern` と `d1_databases[0].database_id` だけ。
    それ以外(workers_dev・preview_urls・observability・build.command など)は触らない。
*/
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_CONFIG_ENV,
  ADMIN_WRANGLER_PATH,
  DELIVERY_CONFIG_ENV,
  DELIVERY_WRANGLER_PATH,
  readWranglerConfig,
  REPO_ROOT,
} from "./wrangler-config.mjs";

export const LOCAL_OVERRIDE_PATH = path.join(REPO_ROOT, "deploy.local.json");
export const DELIVERY_GENERATED_PATH = path.join(REPO_ROOT, "wrangler.delivery.generated.jsonc");
export const ADMIN_GENERATED_PATH = path.join(REPO_ROOT, "wrangler.admin.generated.jsonc");

/** 追跡している `wrangler.*.jsonc` に入っているプレースホルダ。 */
export const PLACEHOLDER_DELIVERY_HOST = "adpop.example.com";
export const PLACEHOLDER_ADMIN_HOST = "adpop-admin.example.com";
export const PLACEHOLDER_DATABASE_ID = "REPLACE_WITH_YOUR_D1_DATABASE_ID";

const LOCAL_KEYS = ["deliveryHost", "adminHost", "databaseId"];

/** ホスト名を比べる前の正規化(ASCII の大文字だけを小文字にする)。ホスト名の比較はすべてこれを通す。 */
export function normalizeHost(host) {
  return typeof host === "string" ? host.replace(/[A-Z]/g, (c) => c.toLowerCase()) : host;
}

/** 2つのホスト名が同じか(大文字小文字を区別しない。どちらかがホスト名でなければ false)。 */
export function sameHost(a, b) {
  return typeof a === "string" && typeof b === "string" && a !== "" && normalizeHost(a) === normalizeHost(b);
}

/** `example.com` とそのサブドメインは、文書用の予約ドメインなのでプレースホルダとして断る。 */
export function isPlaceholderHost(host) {
  const h = normalizeHost(host);
  return typeof h === "string" && (h === "example.com" || h.endsWith(".example.com"));
}

/**
 * `workers.dev` とその全サブドメイン。Custom Domain ではなく workers.dev で受ける設計はとらないので、ホスト名には使えない
 * (比べる前に `normalizeHost` を通す)。
 */
export function isWorkersDevHost(host) {
  const h = normalizeHost(host);
  return typeof h === "string" && (h === "workers.dev" || h.endsWith(".workers.dev"));
}

/** スキーム・パス・ワイルドカード・ポートの無い、ドット区切りのホスト名か。 */
export function isBareHostname(host) {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i.test(host)
  );
}

/** `deploy.local.json` の中身(JSON.parse 済み)の問題点を一覧で返す(0件なら合格)。 */
export function localOverrideProblems(local) {
  if (typeof local !== "object" || local === null || Array.isArray(local)) {
    return ["deploy.local.json が JSON の object ではない"];
  }
  const problems = [];
  for (const key of Object.keys(local)) {
    if (!LOCAL_KEYS.includes(key)) problems.push(`deploy.local.json に知らない鍵がある: ${key}(使える鍵: ${LOCAL_KEYS.join("・")})`);
  }
  for (const key of LOCAL_KEYS) {
    if (typeof local[key] !== "string" || local[key].trim() === "") problems.push(`deploy.local.json の ${key} が無い(空でない文字列が要る)`);
  }
  for (const key of ["deliveryHost", "adminHost"]) {
    const value = local[key];
    if (typeof value !== "string" || value === "") continue;
    if (!isBareHostname(value)) problems.push(`deploy.local.json の ${key} がホスト名の形ではない(https:// やパス・* は付けない): ${JSON.stringify(value)}`);
    else if (isPlaceholderHost(value)) problems.push(`deploy.local.json の ${key} がプレースホルダ(example.com)のまま: ${value}`);
    else if (isWorkersDevHost(value)) problems.push(`deploy.local.json の ${key} が workers.dev のホスト(自分のドメインの Custom Domain にする。ローカル確認用なら adpop.ci.test のような .test ドメインでよい): ${value}`);
  }
  if (sameHost(local.deliveryHost, local.adminHost)) {
    problems.push("deploy.local.json の deliveryHost と adminHost が同じ(別のホスト名にする。docs/deploy.md)");
  }
  if (local.databaseId === PLACEHOLDER_DATABASE_ID) problems.push("deploy.local.json の databaseId がプレースホルダのまま");
  return problems;
}

/**
 * 追跡している `wrangler.*.jsonc` が、仮の値(プレースホルダ)のままかを見る。問題が無ければ `[]`。
 * 自分のドメインや D1 の id を直接書いた設定は、`deploy.local.json` が無いまま deploy へ進めてしまうので断る。
 */
export function trackedConfigProblems({ label, config, placeholderHost }) {
  const problems = [];
  const routes = config?.routes;
  if (!Array.isArray(routes) || routes.length !== 1 || routes[0]?.pattern !== placeholderHost) {
    problems.push(`${label}: 追跡している設定の routes が仮の値(${placeholderHost})の1件ではない。自分のドメインは deploy.local.json に書く(docs/deploy.md)`);
  }
  const databases = config?.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || databases[0]?.database_id !== PLACEHOLDER_DATABASE_ID) {
    problems.push(`${label}: 追跡している設定の database_id が仮の値(${PLACEHOLDER_DATABASE_ID})ではない。自分の D1 の id は deploy.local.json に書く(docs/deploy.md)`);
  }
  return problems;
}

/** `routes[0].pattern` と `d1_databases[0].database_id` だけを差し替えた新しい設定を返す(元は変えない)。ホスト名は小文字にして書く。 */
export function applyLocalOverride(config, { host, databaseId }) {
  const next = structuredClone(config);
  if (Array.isArray(next.routes) && typeof next.routes[0] === "object" && next.routes[0] !== null) {
    next.routes[0].pattern = normalizeHost(host);
  }
  if (Array.isArray(next.d1_databases) && typeof next.d1_databases[0] === "object" && next.d1_databases[0] !== null) {
    next.d1_databases[0].database_id = databaseId;
  }
  return next;
}

/**
 * wrangler を起動するときの環境変数。build.command の検査(`scripts/check-*.mjs`)に「いま使う設定」を教え、
 * 管理画面のビルドに埋め込む配信元を、配信 Worker のホストから決める(deploy・dev の両方が同じものを使う)。
 */
export function guardEnv(rendered, baseEnv = process.env) {
  const env = { ...baseEnv, [DELIVERY_CONFIG_ENV]: rendered.delivery, [ADMIN_CONFIG_ENV]: rendered.admin };
  if (!env.NEXT_PUBLIC_DELIVERY_ORIGIN) {
    const host = readWranglerConfig(rendered.delivery).routes?.[0]?.pattern;
    if (typeof host === "string") env.NEXT_PUBLIC_DELIVERY_ORIGIN = `https://${host}`;
  }
  return env;
}

/** `deploy.local.json` を読む。無い・壊れていれば throw。 */
export function readLocalOverride(file = LOCAL_OVERRIDE_PATH) {
  if (!existsSync(file)) {
    throw new Error("deploy.local.json が無い。自分のドメインと D1 の id をこのファイルに書いてから実行する(docs/deploy.md §2)");
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const problems = localOverrideProblems(parsed);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return parsed;
}

/**
 * 追跡している 2 つの設定(仮の値だけが入っている)に `deploy.local.json` を重ね、`wrangler.*.generated.jsonc` に書く。
 * 書いたファイルのパスを返す。`deploy.local.json` が無い・壊れている・追跡している設定が仮の値でないときは throw
 * (何も書かない)。
 */
export function renderGeneratedConfigs({
  localPath = LOCAL_OVERRIDE_PATH,
  deliveryPath = DELIVERY_WRANGLER_PATH,
  adminPath = ADMIN_WRANGLER_PATH,
  deliveryOut = DELIVERY_GENERATED_PATH,
  adminOut = ADMIN_GENERATED_PATH,
} = {}) {
  const local = readLocalOverride(localPath);
  const delivery = readWranglerConfig(deliveryPath);
  const admin = readWranglerConfig(adminPath);
  const problems = [
    ...trackedConfigProblems({ label: "配信", config: delivery, placeholderHost: PLACEHOLDER_DELIVERY_HOST }),
    ...trackedConfigProblems({ label: "管理画面", config: admin, placeholderHost: PLACEHOLDER_ADMIN_HOST }),
  ];
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const banner = "// 自動生成(npm run config:render)。.gitignore 済み。直接編集しない。\n";
  const nextDelivery = applyLocalOverride(delivery, { host: local.deliveryHost, databaseId: local.databaseId });
  const nextAdmin = applyLocalOverride(admin, { host: local.adminHost, databaseId: local.databaseId });
  writeFileSync(deliveryOut, banner + JSON.stringify(nextDelivery, null, 2) + "\n");
  writeFileSync(adminOut, banner + JSON.stringify(nextAdmin, null, 2) + "\n");
  return { delivery: deliveryOut, admin: adminOut };
}
