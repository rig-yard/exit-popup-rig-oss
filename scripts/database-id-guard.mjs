/*
  配信と管理画面、2つの wrangler 設定の `database_id` が同じ D1 を指しているかを見る純粋関数。
  deploy 前の検査(`scripts/check-database-ids-match.mjs`)とテスト(`tests/admin-config.test.ts`)の
  両方がこの1本だけを呼ぶ。

  片方だけ別の有効な id に差し替えると、マイグレーションも両 deploy も**成功したまま**
  配信と管理画面が別の D1 を見る(どちらのコマンドもエラーにならない)。

  🔴 **仮の値(追跡している設定に入っているプレースホルダ)は、一致していても断る。**
  両方とも仮の値のまま揃っている状態(= まだ自分の D1 を作っていない・`deploy.local.json` を
  書いていない)を合格にしない。仮の値の定義は `scripts/deploy-config.mjs` の1か所だけが持つ。

  ⚠ 見ているのは「2つの設定の値」だけ。その id が実在するか・自分のアカウントの D1 かは、
  Cloudflare に問い合わせないと分からないので見ていない(deploy 時に Cloudflare が断る)。
*/
import { PLACEHOLDER_DATABASE_ID } from "./deploy-config.mjs";

export { PLACEHOLDER_DATABASE_ID };

export function isPlaceholderDatabaseId(id) {
  return id === PLACEHOLDER_DATABASE_ID;
}

/**
 * `database_id` の問題点を一覧で返す(0件なら合格)。各要素は
 * `{ kind: "missing" | "placeholder" | "mismatch", message: string }`。
 * - 片方または両方が読めない → `missing`
 * - 片方または両方が仮の値 → `placeholder`(**一致していても**)
 * - 一致しない → `mismatch`
 */
export function databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId }) {
  if (!deliveryDatabaseId || !adminDatabaseId) {
    return [
      {
        kind: "missing",
        message: `database_id が読めない(delivery=${deliveryDatabaseId ?? "(無し)"} / admin=${adminDatabaseId ?? "(無し)"})`,
      },
    ];
  }

  const problems = [];
  if (isPlaceholderDatabaseId(deliveryDatabaseId)) {
    problems.push({ kind: "placeholder", message: "配信の設定の database_id が仮の値(プレースホルダ)のまま(deploy.local.json の databaseId を設定する。docs/deploy.md)" });
  }
  if (isPlaceholderDatabaseId(adminDatabaseId)) {
    problems.push({ kind: "placeholder", message: "管理画面の設定の database_id が仮の値(プレースホルダ)のまま(deploy.local.json の databaseId を設定する。docs/deploy.md)" });
  }
  if (deliveryDatabaseId !== adminDatabaseId) {
    problems.push({
      kind: "mismatch",
      message:
        `配信と管理画面の設定の database_id が一致しない` +
        `(delivery=${deliveryDatabaseId} / admin=${adminDatabaseId})。配信と管理画面が別の D1 を見ます。`,
    });
  }
  return problems;
}
