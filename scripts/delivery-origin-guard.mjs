/*
  管理画面のビルドに渡す配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)が、配信 Worker が実際に受ける
  Custom Domain と**完全一致**しているかを見る純粋関数。形の一致(`https://…` であれば通す)では
  合格にしない: 別のドメイン・1文字違い・`http://`・末尾のパスは、埋め込みタグや画像の読み込み元が
  配信 Worker と食い違ったまま deploy される。

  期待値は配信側の設定(`routes[0].pattern`)から作る。値を書く場所は `deploy.local.json`
  の1か所だけで、ここには持たない。ホスト名は大文字小文字を区別しない(`normalizeHost` を通して比べる)。
*/

import { normalizeHost } from "./deploy-config.mjs";

/** 配信 Worker のホスト名から、期待する配信元(`https://<host>`)を作る。ホストが読めなければ空文字。 */
export function expectedDeliveryOrigin(deliveryHost) {
  return typeof deliveryHost === "string" && deliveryHost !== "" ? `https://${deliveryHost}` : "";
}

/**
 * 期待する配信元と、実際に渡された `NEXT_PUBLIC_DELIVERY_ORIGIN` を比べる。問題が無ければ `[]`。
 * - 期待する配信元が作れない(配信側の設定にホストが無い)→ 止める
 * - **完全一致**でなければ止める(末尾の `/` だけは許す: アプリ側が同じ正規化をしている)
 */
export function deliveryOriginGuardProblems({ actualOrigin, expectedOrigin }) {
  const expected = (expectedOrigin ?? "").trim();
  if (expected === "") {
    return ["配信側の設定(routes[0].pattern)にホスト名が無く、期待する配信元を決められない"];
  }
  const actual = (actualOrigin ?? "").replace(/\/$/, "");
  if (normalizeHost(actual) !== normalizeHost(expected)) {
    return [
      `NEXT_PUBLIC_DELIVERY_ORIGIN が配信 Worker のホストと完全には一致しない` +
        `(expected=${JSON.stringify(expected)} / actual=${JSON.stringify(actual)})`,
    ];
  }
  return [];
}
