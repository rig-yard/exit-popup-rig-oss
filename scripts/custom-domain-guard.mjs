/*
  両 Worker が Custom Domain(ホスト名の完全一致)で受けていて、workers.dev と zone の routes の
  どちらにも頼っていないかを見る純粋関数。判定はこの1本だけが持つ。

  🔴 **zone の routes(パターンで受ける方式)は使わない。** 同じホスト名に一致する zone の route は、
  Custom Domain の Worker より前に走る(Cloudflare 公式文書「Custom Domains」)。広い pattern を
  持つ別の Worker が1つ増えるだけで、配信・管理画面の通信を横取りできる経路になる。この検査は
  `custom_domain: true` が付いていない route(= zone の route)を**1件でも**見つけたら落とす。

  🔴 **workers_dev は明示的に false でなければ落とす。** ダッシュボードで切るだけでは次の deploy で
  戻る(Cloudflare 公式文書「workers.dev」)ため、設定ファイルの値そのものを見る。

  🔴 **ホスト名は、1件だけ・素のホスト名(スキーム・パス・`*` 無し)・プレースホルダ(example.com)
  ではない、のすべてを満たさなければ落とす。** ホスト名そのものは利用者が決める値なので、固定値との
  一致は見ない。配信と管理画面が同じホストにならないことは `localOverrideProblems` と
  `distinctHostProblems` が見る。
*/
import { isBareHostname, isPlaceholderHost, isWorkersDevHost, sameHost } from "./deploy-config.mjs";

/**
 * `workers_dev` が明示的に `false` になっているかを見る。問題が無ければ `[]`。
 */
export function workersDevDisabledProblems({ label, workersDev }) {
  if (workersDev !== false) {
    return [`${label}: workers_dev が false になっていない(現在=${JSON.stringify(workersDev)})`];
  }
  return [];
}

/**
 * `routes` が「Custom Domain だけで、素のホスト名1件(プレースホルダではない)」かを見る。
 * 問題が無ければ `[]`。
 * - `routes` が無い/配列でない/空 → 問題
 * - `custom_domain: true` が付いていない route(= zone の route)が1件でもある → 問題
 * - `pattern` が1件でない・素のホスト名でない・プレースホルダ → 問題
 */
/** `route` オブジェクトが持つことを許す鍵は、この2つだけ(`pattern` と `custom_domain`)。 */
const ALLOWED_ROUTE_KEYS = ["pattern", "custom_domain"];

export function customDomainRouteProblems({ label, routes }) {
  const problems = [];

  if (!Array.isArray(routes) || routes.length === 0) {
    problems.push(`${label}: routes が無い(Custom Domain の設定が無い)`);
    return problems;
  }

  for (const route of routes) {
    if (typeof route !== "object" || route === null) {
      problems.push(`${label}: routes の要素が object ではない: ${JSON.stringify(route)}`);
      continue;
    }
    if (route.custom_domain !== true) {
      problems.push(`${label}: zone の routes(custom_domain: true が付いていない route)がある: ${JSON.stringify(route)}`);
    }
    // 🔴 `custom_domain: true` だけでは、`zone_name`/`zone_id`(zone の route の鍵)・
    //   `enabled: false`(Cloudflare の公式スキーマに在る。無効化されていても検査は合格してしまう)・
    //   `previews_enabled` が混ざっていても合格してしまう。route オブジェクトは
    //   `pattern`・`custom_domain` の2つの鍵だけを許し、他の鍵が1つでもあれば落とす。
    const extraKeys = Object.keys(route).filter((key) => !ALLOWED_ROUTE_KEYS.includes(key));
    if (extraKeys.length > 0) {
      problems.push(
        `${label}: route に ${ALLOWED_ROUTE_KEYS.join("・")} 以外の鍵がある(${extraKeys.join("・")}): ${JSON.stringify(route)}`,
      );
    }
  }

  // routes の件数そのものを、pattern の有無とは独立に見る(pattern の無い route を数え漏らさない)
  if (routes.length !== 1) {
    problems.push(`${label}: routes がちょうど1件ではない(実際=${routes.length}件)`);
  }

  const patterns = routes.map((route) => (route && typeof route === "object" ? route.pattern : undefined)).filter(Boolean);

  if (patterns.length !== 1) {
    problems.push(`${label}: Custom Domain のホストがちょうど1件ではない(実際=${JSON.stringify(patterns)})`);
  } else if (!isBareHostname(patterns[0])) {
    problems.push(`${label}: routes の pattern が素のホスト名ではない(スキーム・パス・* は付けない): ${JSON.stringify(patterns[0])}`);
  } else if (isWorkersDevHost(patterns[0])) {
    problems.push(`${label}: routes の pattern が workers.dev のホスト: ${patterns[0]}(自分のドメインの Custom Domain にする。docs/deploy.md)`);
  } else if (isPlaceholderHost(patterns[0])) {
    problems.push(`${label}: routes の pattern がプレースホルダ(example.com)のまま: ${patterns[0]}(deploy.local.json の deliveryHost / adminHost を設定する。docs/deploy.md)`);
  }

  return problems;
}

/** 配信と管理画面のホストが同じなら問題(別々の Worker が同じホストを取り合う)。 */
export function distinctHostProblems({ deliveryHost, adminHost }) {
  if (sameHost(deliveryHost, adminHost)) {
    return [`配信と管理画面が同じホスト名(${deliveryHost})になっている`];
  }
  return [];
}
