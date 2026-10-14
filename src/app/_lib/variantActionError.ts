/*
  パターン(バリアント)への操作(配信トグル=archive/restore・削除)が失敗したときの短い文言。
  🔴 元は `src/app/popup/page.tsx` の `variantActionErrorMessage`(アーカイブ専用)だったが、
    操作が `VariantCard` 自身に移ったため、ここへ切り出して両方から使えるようにした。
    ロジック自体は変えていない。
*/
import type { ApiResult } from "./api";

export function variantActionErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (result.status === 401) return "セッションが切れました。再度ログインしてください。";
  if (result.status === 404) return "見つかりませんでした。画面を再読み込みしてください。";
  // 🔴 #8 が返す値(src/admin/app.ts fromResult)。サーバーが message を一緒に返すのでそのまま出す
  //   (「稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください」)。
  if (result.status === 409 && (result.reason === "last_deliverable_variant" || result.reason === "no_deliverable_variant")) {
    return result.message ?? "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください";
  }
  // 🔴 戻す(restore)側だけが踏む経路。パターンの上限(variantsPerPopup)に達していると
  //   DBのトリガが断る(src/lib/data/admin.ts restoreVariant のコメント参照)。
  if (result.status === 409 && result.reason === "limit") return "パターンの上限に達しています。";
  return "操作できませんでした。もう一度お試しください。";
}
