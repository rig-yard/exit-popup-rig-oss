/*
  キャンペーンの中(`/popup`)で編集中の入力を、タブ内(`sessionStorage`)に保存し、
  ページを離れて戻ってきたら(戻るボタン・サイドバー・再読み込みのどれでも)元どおりの
  編集状態で復元する。

  🔴 全ページの移動をソフト遷移にする変更(`navigationBoundary.ts` を撤去)で、`/popup` は
  他のページへソフトで移るたびに `popup/page.tsx` 自身がアンマウントされ、React state(編集中の
  入力)が失われるようになった。それを補うのがこの仕組み——「確認が無くても入力が消えない」
  作りにすることで、離脱確認そのものを不要にする(タブを閉じる・外部へ移るときの
  `beforeunload` はそのまま残す。`_lib/unsavedChanges.ts`。変更していない)。

  持つもの(キャンペーン1つにつき1エントリ。キーは popupId で分ける):
  - `name`: キャンペーン名のインライン編集中の入力(編集していなければ null)
  - `draftOrder`: まだ保存していない下書きパターンの並び(キーの配列)
  - `cards`: 編集中のパターン(既存パターンの編集モード・下書き)のキー→入力中の値

  🔴 サーバー側の値が入力途中より新しくなっていた場合の扱い(推奨・決定):
  **既存パターンの編集中・キャンペーン名の編集中のどちらも、discard する(復元しない)**。
  `cards[id].baseline`・`name.baseline` に「編集を始めた時点でサーバーから見えていた値」を
  一緒に持たせ、復元する直前に読み込んだ最新の値(`variant`・`popup.name`)と比べる
  (呼び出し側=`popup/page.tsx` が `isDirtyFrom`・文字列の一致で比較する)。違っていたら、
  誰か・何かがその間にサーバーの値を変えた(同じ利用者の別タブ・別操作)ので、古い入力を復元して
  上書き保存してしまう事故を避け、黙って最新のサーバー値をそのまま表示する(復元しない。
  確認モーダルを出して選ばせる案より、この画面の利用頻度・同時編集の起きにくさに対して実装が
  軽く、「気づかれずに上書きされる」最悪のケースを避けられれば十分と判断した)。
  下書き(`cards[id].baseline === null`)はサーバーに値が無いので、この比較自体が無く常に復元する。

  読み書きは try/catch で包み、`sessionStorage` が使えない(プライベートブラウジング・
  容量超過等)環境でも画面は普通に動く(保存・復元ができないだけ)。
*/
import type { SyncedFields } from "./variantSync";

export type PersistedCard = {
  /** 編集を始めた時点でサーバーから見えていた値。下書き(サーバーにまだ存在しない)は null。 */
  baseline: SyncedFields | null;
  /** 今の入力(画像ファイル自体は持たない。選び直しが必要——ファイルはsessionStorageに保存できないため)。 */
  fields: SyncedFields;
};

/** 編集を始めた時点でサーバーから見えていた名前(baseline)+ 今の入力(value)。 */
export type PersistedName = { baseline: string; value: string };

export type PopupEditSnapshot = {
  name: PersistedName | null;
  draftOrder: string[];
  cards: Record<string, PersistedCard>;
};

export const EMPTY_POPUP_EDIT_SNAPSHOT: PopupEditSnapshot = { name: null, draftOrder: [], cards: {} };

/** 保存先のキーの接頭辞(`clearAllPopupEditSnapshots` が列挙にも使う)。 */
const STORAGE_KEY_PREFIX = "adpop:popup-edit:";

function storageKey(popupId: string): string {
  return `${STORAGE_KEY_PREFIX}${popupId}`;
}

function isSyncedFields(value: unknown): value is SyncedFields {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "text" || v.kind === "image" || v.kind === "chatbot") &&
    typeof v.headline === "string" &&
    typeof v.body === "string" &&
    typeof v.buttonLabel === "string" &&
    typeof v.imageAlt === "string" &&
    typeof v.destinationUrl === "string"
  );
}

function isPersistedCard(value: unknown): value is PersistedCard {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.baseline === null || isSyncedFields(v.baseline)) && isSyncedFields(v.fields);
}

function isPersistedName(value: unknown): value is PersistedName {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.baseline === "string" && typeof v.value === "string";
}

/** 壊れた値・旧バージョンの形は復元しない(空のスナップショットとして扱う)。 */
function parseSnapshot(raw: string): PopupEditSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) return EMPTY_POPUP_EDIT_SNAPSHOT;
  const v = parsed as Record<string, unknown>;
  if (v.name !== null && !isPersistedName(v.name)) return EMPTY_POPUP_EDIT_SNAPSHOT;
  if (!Array.isArray(v.draftOrder) || !v.draftOrder.every((k) => typeof k === "string")) return EMPTY_POPUP_EDIT_SNAPSHOT;
  if (typeof v.cards !== "object" || v.cards === null) return EMPTY_POPUP_EDIT_SNAPSHOT;
  const cardsIn = v.cards as Record<string, unknown>;
  const cards: Record<string, PersistedCard> = {};
  for (const [key, card] of Object.entries(cardsIn)) {
    if (isPersistedCard(card)) cards[key] = card;
  }
  return { name: (v.name as PersistedName | null) ?? null, draftOrder: v.draftOrder as string[], cards };
}

/**
 * 保存する `draftOrder` を、`cards` に実際に持ち分があるキーだけに絞る(副作用無しの純粋関数)。
 * 🔴 下書きの「保存」を押した瞬間、`VariantCard`は
 *   `cards`の持ち分だけを先回りして消す(保存を試す前)が、`draftKeys`(そのカードが画面に
 *   残っている間は変えない枠)はまだそのキーを持つ。`cards`より広い`draftOrder`をそのまま保存
 *   すると、復元時に「中身の無い空の下書き枠」が余分に増える(二重表示の変種)。POSTが失敗して
 *   `cards`へ書き戻されたら、次の呼び出しで自動的にまた含まれる(`cards`と`draftOrder`が
 *   常に同じ基準=「持ち分が実在するか」で揃う)。
 */
export function persistableDraftOrder(draftKeys: readonly string[], cards: Record<string, PersistedCard>): string[] {
  return draftKeys.filter((key) => key in cards);
}

export function loadPopupEditSnapshot(popupId: string): PopupEditSnapshot {
  try {
    const raw = window.sessionStorage.getItem(storageKey(popupId));
    if (raw === null) return EMPTY_POPUP_EDIT_SNAPSHOT;
    return parseSnapshot(raw);
  } catch {
    return EMPTY_POPUP_EDIT_SNAPSHOT;
  }
}

/**
 * 🔴 ログアウト・401によるログイン送り出しの後、別の利用者(同じ端末・
 *   同じブラウザ)が別のアカウントでログインしたとき、前のアカウントの編集中の入力が
 *   sessionStorageに残っていて、たまたま同じpopupIdのキャンペーンを開くと復元されてしまう
 *   (WORKSPACE名キャッシュの消去=`workspaceCache.ts`の`clearCachedWorkspaceName`と同じ理由)。
 *   ログアウト・401の各経路(`Sidebar.tsx`・`_lib/useRequireSession.ts`・`_lib/api.ts`)から、
 *   このタブが持つ `/popup` の編集中データを**接頭辞ごと全部**消す。
 */
export function clearAllPopupEditSnapshots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key !== null && key.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // 使えない環境では諦める(そもそも書けていないので消す必要もない)
  }
}

/** 持つものが無くなったら(保存・キャンセルが全部済んだら)キーごと消す——残骸を残さない。 */
export function savePopupEditSnapshot(popupId: string, snapshot: PopupEditSnapshot): void {
  try {
    const isEmpty = snapshot.name === null && snapshot.draftOrder.length === 0 && Object.keys(snapshot.cards).length === 0;
    if (isEmpty) {
      window.sessionStorage.removeItem(storageKey(popupId));
      return;
    }
    window.sessionStorage.setItem(storageKey(popupId), JSON.stringify(snapshot));
  } catch {
    // 使えなくても(プライベートブラウジング・容量超過等)画面は普通に動く。保存できないだけ。
  }
}
