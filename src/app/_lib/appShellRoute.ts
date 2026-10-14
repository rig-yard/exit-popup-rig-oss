/*
  サイドバー(AppShell)を `src/app/(app)/layout.tsx` に1回だけ置くための、純粋な導出ロジック。

  🔴 ページを移るたびにサイドバーが作り直される: 静的書き出しはページごとに
    別のHTMLで、以前はページごとに `<AppShell>` を描いていた(各 `page.tsx` 参照)ため、
    クライアント側遷移にしても画面の根(layout)から下が毎回作り直されていた。
    `(app)` ルートグループの共通 `layout.tsx` に `<AppShell>` を1回だけ置き、
    中身(各ページ)だけを差し替える。

  `activeNav`(サイドバーのどの項目を強調するか)と、パンくず(`breadcrumbItems`)は、
  **どちらも今居るURLだけから決まる**(例外は `/popup` の siteId だけ——本体の取得が終わるまで
  確定しないため、`_lib/appShellOverride.tsx` 経由でページ側から上書きする)。
  ここに1本化することで、ページごとに同じ分岐を書き写して食い違わせる事故を避ける。
*/
import type { NavKey } from "../_components/Sidebar";

export type BreadcrumbItem = { label: string; href?: string };

/** サイドバーのどの項目を強調するか。`/popups`・`/popup`(キャンペーンの一覧・詳細)は同じ「デザイン」。 */
export function navKeyForPath(pathname: string): NavKey {
  if (pathname.startsWith("/display")) return "display";
  if (pathname.startsWith("/tags")) return "tags";
  if (pathname.startsWith("/popup")) return "design"; // /popups, /popup の両方に当たる
  return "dashboard";
}

/**
 * パンくず。`/popup`(キャンペーン詳細)の siteId は URL に無く、本体の取得が終わるまで
 * 確定しない——呼び出し側(layout.tsx)は `appShellOverride` から受け取った siteId をここに渡す。
 * 他のページは `?site=` のURLクエリそのままでよい(確定を待つ必要が無い)。
 */
export function breadcrumbItemsForPath(pathname: string, siteId: string): BreadcrumbItem[] {
  if (pathname === "/popups") return [{ label: "デザイン" }];
  if (pathname === "/popup") return siteId !== "" ? [{ label: "デザイン", href: `/popups?site=${siteId}` }] : [];
  if (pathname === "/display") return [{ label: "表示設定" }];
  return []; // /dashboard, /tags: 見出し(h1)と同じ文言になるため出さない(既存の方針どおり)
}

/**
 * サイドバーの枠自体を出さない画面か。
 * 🔴 `/tags` で `?site=` が無いのは、0件(新しく立てた直後)の初回設定、または `?site=` を
 *   持たない古いブックマーク・直リンク(`tags/page.tsx` が裏で `GET /sites` を確かめ、
 *   既にあれば `/tags?site=...` へ送り直す。その送り直しが終わるまでの一瞬も含む)——
 *   どちらもこの画面はサイドバーを出す前提で作っていない(切り替えるサイトが無い・まだ
 *   確定していない)。URLだけから同期的に判定できるので、layout の初回描画から確定し、
 *   サイドバーが一瞬出て消える、を避ける。
 */
export function isAppShellHidden(pathname: string, siteId: string): boolean {
  return pathname === "/tags" && siteId === "";
}
