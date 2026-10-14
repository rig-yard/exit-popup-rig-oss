/*
  各操作(pause/activate/archive/restore/delete)が成功した直後に、サーバーが確定させた値を
  ローカルの `popups` に反映する純関数群。
  🔴 楽観的更新ではない: POST/DELETE の成功を確認した**後**に呼ぶ(呼び出し元は
  popups/page.tsx の `runAction`/`handleDelete`)。失敗したときはこれらを呼ばないので、
  `popups` state は一度も書き換わらず、画面はクリック前の状態のまま残る
  (戻す処理が要らない。失敗時に別途ロールバックするコードは無い)。

  それぞれの規則は `src/lib/data/admin.ts` の実装(サーバー側の正)を読んで書き写したもの。
  - pausePopup(admin.ts:409-412): 対象が active のときだけ paused にする(他は何も変えない。
    SQLの `case when status = 'active' then 'paused' else status end` がそのまま条件)。
  - activatePopup(admin.ts:445-466): 対象を active にする**のと同じトランザクションで**、
    同じサイトの他の active を paused にする(1サイト1つしか稼働できない制約)。
  - archivePopup(admin.ts:415-424): 対象の archivedAt を立てる(既に立っていれば変えない
    = SQLの `coalesce`)。対象が active だったら paused にする(稼働中のままアーカイブは
    できない制約)。
  - restorePopup(admin.ts:427-430): 対象の archivedAt を null に戻すだけ。status は
    変えない(SQLが `archived_at = null` の1列しか触っていない)。
  - deletePopup(admin.ts:433-436): 行そのものが消える(cascade)。

  これらの値と、直後に呼ぶ `load()` の再取得が食い違わないこと(古い `load()` の応答が
  後から来てこの値を上書きしないこと)は、`_lib/latestWins.ts` の世代ガードが別の場所で保証する。
*/
import type { ApiPopup } from "./types";

/**
 * トグルをONにしたとき(action="activate")に実際に呼ぶ API の順番。
 * 🔴 `GET /sites/:id/popups` はアーカイブ済みも含めて返す(`listPopups` が archived_at で絞っていない)
 *   ため、アーカイブ済みのキャンペーンも一覧に普通の行として出る。そのままトグルをONにすると
 *   `activatePopup` の `archived_at is null` 条件に必ず当たらず、死んだボタンになっていた。
 * 🔴 最終判断: アーカイブ済みは「停止」の行として普通に表示し、ONにしたら
 *   **restore → activate の順で呼ぶ**(画面にアーカイブという概念は出さない)。
 *   pause、または非アーカイブの activate は単独のまま(呼び出しを増やさない)。
 */
export function actionsForToggle(popup: ApiPopup, action: "pause" | "activate"): Array<"restore" | "pause" | "activate"> {
  if (action === "activate" && popup.archivedAt !== null) return ["restore", "activate"];
  return [action];
}

export function applyDeliveryActionResult(
  popups: ApiPopup[] | null,
  popupId: string,
  action: "pause" | "activate",
): ApiPopup[] | null {
  if (popups === null) return popups;
  const target = popups.find((p) => p.id === popupId);
  if (target === undefined) return popups;

  if (action === "pause") {
    // サーバー(pausePopup)は対象が active のときだけ paused にする。他の行には触れない。
    if (target.status !== "active") return popups;
    return popups.map((p) => (p.id === popupId ? { ...p, status: "paused" } : p));
  }

  // activate: サーバー(activatePopup)は、同じサイトの他の active を paused にしてから
  // 対象を active にする(1トランザクション。1サイトにつき稼働できるのは1件だけ)。
  return popups.map((p) => {
    if (p.id === popupId) return { ...p, status: "active" };
    if (p.siteId === target.siteId && p.status === "active") return { ...p, status: "paused" };
    return p;
  });
}

/**
 * archivePopup 成功後の反映。サーバーは archivedAt を立て、対象が active だったら
 * paused にする(他の行には触れない)。タイムスタンプの実際の値は画面に出さないので
 * (popups/page.tsx は `archivedAt === null` の真偽しか見ない)、非 null であれば十分。
 */
export function applyArchiveResult(popups: ApiPopup[] | null, popupId: string, now: string): ApiPopup[] | null {
  if (popups === null) return popups;
  return popups.map((p) => {
    if (p.id !== popupId) return p;
    return { ...p, archivedAt: p.archivedAt ?? now, status: p.status === "active" ? "paused" : p.status };
  });
}

/** restorePopup 成功後の反映。archivedAt を null に戻すだけ(status は変えない)。 */
export function applyRestoreResult(popups: ApiPopup[] | null, popupId: string): ApiPopup[] | null {
  if (popups === null) return popups;
  return popups.map((p) => (p.id === popupId ? { ...p, archivedAt: null } : p));
}

/** deletePopup 成功後の反映。行そのものを取り除く。 */
export function applyDeleteResult(popups: ApiPopup[] | null, popupId: string): ApiPopup[] | null {
  if (popups === null) return popups;
  return popups.filter((p) => p.id !== popupId);
}
