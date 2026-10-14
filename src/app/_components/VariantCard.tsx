"use client";

/*
  パターン(バリアント)の編集カード。
  `variant` が null = まだ作っていない空き枠(「+ パターンを追加」で生まれた下書き)。

  🔴 代替テキスト(画像の説明・imageAlt)は #8(画像ポップの配信)でスキーマに入った。
    `src/admin/body.ts` の `parseVariant` が `content` に4つ目の鍵として要求し、
    `requiresImageAlt`(画像型・ボタン文言が空のときだけ必須)を入口とデータ層の両方で見る。
    この画面の必須判定(`altRequired`/`altMissing`)は、その関数と同じ条件(kind==="image" かつ
    buttonLabelが空かつimageAltが空)を使う——判定がサーバーとずれると、画面では送れたのに
    サーバーが400で断る/画面で止めたのにサーバーは通る、という食い違いが起きるため。

  🔴 方針(画像の無い画像パターンを保存させない):
    **新しく作る画像パターンは、画像を選んでも「画面の中だけの下書き」のまま持ち、
    実際にAPIへ送るのは「保存」を押した瞬間だけ**にした(先にバリアントだけ作る方式は採らない)。
    「保存」ボタンは画像が選ばれていない間は無効化する。保存の処理順序は
    ①パターンを作成 → ②選んでおいた画像をアップロード、の順で、
    **②が失敗したら①で作ったパターンを消す**(補償のDELETE)。これにより、
    アップロード失敗時に中身の無いパターンがDBに残らない。
    既に保存済みのパターン(画像の差し替え・外した後の選び直し)は、この限りではなく即アップロードする
    (そのパターン自体は差し替え前から有効なレコードとして既に存在しているため)。

  🔴 保存・アップロード・画像の削除が成功したら、
    サーバーへ `GET /variants/:id` を取りに行って**サーバーが実際に持っている値で画面の状態を置き換える**
    (`syncFromServer`)。trimされた値やimageKeyを、送った値をそのまま仮定して表示しない。

  🔴 新規画像パターンで、作成直後のアップロードが失敗したときの補償DELETEの
    結果を確かめていなかった(404・409・通信失敗を黙って握りつぶしていた)。
    `src/app/_lib/variantRecovery.ts` の `recoverFailedImageUpload` に分岐ロジックを切り出し、
    まずGETで実際の状態を確認してから、消す/消さないを決める(詳細はそのファイルのコメント参照)。

  🔴 `syncFromServer` が失敗したときに成功扱いしない
    (`onSaved({ silent: true, errorMessage })` で親にエラーを伝える)。また、親から新しい
    `variant` props が来たとき(他のカードの保存・一覧の再読み込み等)にもこのカードの表示を
    合わせる(`useEffect` で同期。保存・アップロード中は上書きしない)。

  🔴 上のprops同期が、**保存していない入力まで上書きしていた**。
    パターンAを編集中(保存前)に、別の操作(トリガー切替・ポップ設定の保存・別パターンBの
    保存/アーカイブ)が一覧全体を再読み込みさせると、Aの入力が警告なく保存済みの値に戻っていた
    ——「操作中でないこと(busy)」と「未編集であること」は同義ではない。
    `src/app/_lib/variantSync.ts` に dirty 判定を切り出し、**最後にサーバーと同期した値(baseline)
    と今の入力が違うカードには props 同期をかけない**。そのカード自身の保存・画像の回復処理での
    再同期が成功したときだけ baseline を更新する(`markSynced`)。

  🔴 dirtyガードが**props同期のeffectにしか効いていない**状態では不十分だった。
    既存パターンの文字欄を編集中(未保存)のまま「差し替え」で画像を選ぶと、アップロード成功後の
    直接の再同期(`uploadToExisting` → 旧`syncFromServer` → `applyVariant`)が、
    dirtyを見ずにカード全体をサーバーの古い文字の値で上書きしていた。
    `applyVariant`/`syncFromServer`/`syncImageFromServer` の呼び出し経路を洗い出し、
    「何を確定したか」で反映する範囲を分けた(表は下):
    - 文字欄を送った経路(保存・新規作成時のアップロード)→ `syncFromServer`(全部を反映してよい。
      送った値と確定する値が一致する前提が成り立つ)
    - 画像だけを確定した経路(既存パターンの差し替え・外す)→ 画像の状態(`imageKey`)だけを反映し、
      文字欄・baselineには触れない(差し替え=`syncImageFromServer`、外す=DELETEの結果を直接反映)

  🔴 カードの形を作り替えた: ふだんは**表示だけ**(見出し・本文・ボタン文言・
    遷移先・画像・画像の説明を読める形で並べる。未入力の項目は項目ごと出さない)+右にプレビュー。
    右上の「…」(`PatternMenu`)から「編集」を押すと、そのカードだけ入力欄に切り替わり、
    カードの右下に「キャンセル」(未保存なら確認)+「保存」が出る。この表示/編集の切り替えは
    **既存の保存済みパターンだけ**が持つ状態(下書き=`variant===null`は元から常に入力欄のまま。
    保存前のものを「表示」する意味が無いため)。
    配信トグル(左上)は、パターンに「ステータス」が無いため `archivedAt` の有無を
    「配信中(停止)」の言葉で表す(トグルOFF=archive・ON=restore。`archive`という語は画面に出さない)。
    稼働中キャンペーンで最後の配れるパターンを止める・削除するのは既存のサーバー側の拒否
    (`last_deliverable_variant`)に従い、短いエラーを出す(`variantActionError.ts`)。
    ⚠ 旧来の「配信中」タグ(`isDeliverable`=複数の非アーカイブパターンがあるとき実際に配るのはどれか、
    という別の意味の印)は、このトグルに意味を統合した(「シグネチャのティールは
    両方とも『実際に配信されている』という同じ意味」を踏襲)。
*/
import { useEffect, useId, useRef, useState } from "react";
import { deleteJson, getJson, postJson, putJson, uploadVariantImage } from "../_lib/api";
import { TAP_TARGET_44 } from "../_lib/a11y";
import { deliveryImageUrl } from "../_lib/delivery";
import { imageErrorMessage } from "../_lib/imageErrors";
import { ApiVariant, ApiVariantKind, isDeliverableKind, variantImageKey } from "../_lib/types";
import { recoverFailedImageUpload } from "../_lib/variantRecovery";
import { buildPopupPreview, type PopupPreviewInput } from "../_lib/popupPreview";
import { variantActionErrorMessage } from "../_lib/variantActionError";
import { deleteConfirmVariantStatsText, type EventCounts } from "../_lib/stats";
import {
  computeSyncPatch,
  extractSyncedFields,
  isDirtyFrom,
  shouldApplyPropsSync,
  type SyncedFields,
  type SyncPatch,
} from "../_lib/variantSync";
import { FieldError } from "../_components/ErrorBanner";
import { ConfirmDeleteDialog } from "../_components/ConfirmDeleteDialog";
import { DeliveryToggle } from "../_components/DeliveryToggle";
import { Modal } from "../_components/Modal";
import { PatternMenu, type PatternMenuHandle } from "../_components/PatternMenu";

export type VariantSavedOptions = { silent?: boolean; errorMessage?: string };

/** プレビュー。カードの表示/編集どちらでも同じ枠に同じ描画を置く。 */
function PopupPreviewPane(input: PopupPreviewInput) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { host, destroy } = buildPopupPreview(document, input);
    container.replaceChildren(host);
    return () => {
      destroy();
      container.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input のプリミティブなフィールドだけを依存に使う(下のdepsArray参照)
  }, [input.kind, input.headline, input.body, input.buttonLabel, input.imageAlt, input.destinationUrl, input.imageUrl]);
  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-center rounded-lg bg-paper p-6 lg:w-[380px] lg:shrink-0"
    />
  );
}

/** 表示モードの読むだけの1項目。未入力なら呼び出し側がそもそも描かない(無駄なものは出さない)。 */
function ReadOnlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink/60">{label}</div>
      <div className={`whitespace-pre-wrap break-words text-sm text-ink ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  headline: "見出し",
  body: "本文",
  buttonLabel: "ボタン文言",
  imageAlt: "画像の説明",
  destinationUrl: "遷移先URL",
  kind: "種類",
  content: "入力内容",
};

/** #8 の `last_deliverable_variant`(409)。サーバーが message を一緒に返すので、それをそのまま出す。 */
function lastDeliverableMessage(message: string | undefined): string {
  return message ?? "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください";
}

function isValidHttpsUrl(value: string): boolean {
  return /^https:\/\/[^\s<>"']+$/.test(value) && value.length <= 2048;
}

export function VariantCard({
  variant,
  popupId,
  onSaved,
  onCancelDraft,
  onDirtyChange,
  onBusyChange,
  initialEditing,
  initialFields,
  onLiveChange,
}: {
  variant: ApiVariant | null;
  popupId: string;
  onSaved: (options?: VariantSavedOptions) => Promise<void> | void;
  onCancelDraft: (() => void) | null;
  /**
   * 🔴 ページを離れるときの確認(設計上の要件)。このカードの `dirty`(=既存の判定。新しい判定は作らない)を
   *   そのまま親へ知らせるだけ。下書きカード(variant===null)は呼ばない——`isDirtyFrom` は
   *   baseline が無い下書きを常に dirty=false にする設計(下のコメント参照)だが、下書きの存在
   *   そのものは親が `draftKeys` で既に把握しているので、ここで重ねて判定を作らない。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * 🔴 保存・アップロード・画像削除が**進行中**であることを親へ知らせる。
   *   `dirty`(=未保存の入力差分)とは別の状態——画像の差し替えのような「即時送信」の操作は
   *   文字欄が dirty でなくても、送信中に離脱するとリクエストが中断される。下書きカードも
   *   アップロード中はこれを呼ぶ(dirtyと違い、下書きかどうかを区別しない)。
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * 🔴 `_lib/popupEditSession.ts` からの復元。既存パターンだけが意味を持つ
   *   (下書きは常に編集モードなので `initialEditing` は無視する)。親(`popup/page.tsx`)が
   *   「編集を始めた時点のbaselineと今のサーバー値が一致するか」を確認済みのときだけ渡す。
   */
  initialEditing?: boolean;
  /** 復元する入力中の値(下書き・編集中の既存パターンどちらも)。無ければ通常どおり baseline から始める。 */
  initialFields?: SyncedFields | null;
  /**
   * 🔴 編集中の入力(fields)・編集モード(editing)が変わるたびに親へ知らせる
   *   (`popupEditSession.ts` へ保存するため)。`baseline` も一緒に渡す——既存パターンの
   *   編集を復元してよいかどうかの判定(サーバー値が変わっていないか)に親が使う。
   */
  onLiveChange?: (fields: SyncedFields, editing: boolean, baseline: SyncedFields | null) => void;
}) {
  const initialBaseline = variant ? extractSyncedFields(variant) : null;
  const [kind, setKind] = useState<ApiVariantKind>(initialFields?.kind ?? initialBaseline?.kind ?? "text");
  const [headline, setHeadline] = useState(initialFields?.headline ?? initialBaseline?.headline ?? "");
  const [body, setBody] = useState(initialFields?.body ?? initialBaseline?.body ?? "");
  const [buttonLabel, setButtonLabel] = useState(initialFields?.buttonLabel ?? initialBaseline?.buttonLabel ?? "");
  const [destinationUrl, setDestinationUrl] = useState(initialFields?.destinationUrl ?? initialBaseline?.destinationUrl ?? "");
  const [imageAlt, setImageAlt] = useState(initialFields?.imageAlt ?? initialBaseline?.imageAlt ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(variant?.id ?? null);
  const [imageKey, setImageKey] = useState<string | null>(variant ? variantImageKey(variant) : null);
  // 🔴 「最後にサーバーと同期した値」。これと今の入力が違うカードには
  //   親からの新しい variant props を適用しない(未保存の入力を勝手に上書きしない)。
  const [baseline, setBaseline] = useState<SyncedFields | null>(initialBaseline);
  // 🔴 下書き(savedId===null)が選んだがまだアップロードしていないファイル
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "uploading" | "removing-image" | "toggling-delivery" | "deleting">(
    "idle",
  );
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editableRegionRef = useRef<HTMLDivElement>(null);
  // 🔴 保存・キャンセル・削除確認のキャンセルで
  //   フォーカスを「…」ボタンへ明示的に戻す(Modal/ConfirmDeleteDialogの汎用の「開く前の
  //   フォーカスへ戻す」仕組みは、メニューが先に閉じて項目が消えるためbodyを指してしまう)。
  const patternMenuRef = useRef<PatternMenuHandle>(null);
  // 🔴 `setTimeout(fn, 0)` で
  //   フォーカスを戻すと、busy=false になる再コミットが React のスケジューラ(MessageChannel 等。
  //   非同期関数の続き=このケースのように discrete なイベントから離れた更新は、マイクロタスクより
  //   遅れて反映されることがある)によっては、まだ `disabled` が true のDOMに `.focus` することになり
  //   (disabled要素へのfocusは何もしない)、黙って失敗する。実測: 削除失敗後に
  //   `setTimeout`経由で呼ぶと `disabled=true` のまま——無効なボタンへの`.focus`は失敗する。
  //   `useEffect` にすれば、このカウンタが変わった**コミットの後**(=disabled の最新値が
  //   DOMに反映された後)に確実に実行される。
  const [focusMenuRequestId, setFocusMenuRequestId] = useState(0);
  const submittingRef = useRef(false);
  // 🔴 保存済みパターンは「表示」が既定で、「…」メニューの「編集」を押した
  //   カードだけ入力欄に切り替わる。下書き(variant===null)は元から常に入力欄なので対象外。
  //   `initialEditing` は `popupEditSession.ts` からの復元(親がサーバー値と食い違わないことを
  //   確認済みのときだけ渡す)。
  const [isEditing, setIsEditing] = useState(initialEditing ?? false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // 🔴 削除の確認に stats={null} を渡していたため
  //   「数字も一緒に消えます」が一度も出なかった。null = 未取得または取得失敗(0と区別する)。
  const [deleteStats, setDeleteStats] = useState<EventCounts | null>(null);
  const cancelTitleId = useId();
  const cancelDescId = useId();

  const isDraft = savedId === null;
  const archived = variant !== null && variant.archivedAt !== null;
  // 🔴 「配れるか」は `isDeliverableKind`
  //   (`_lib/types.ts`。サーバーの deliverableVariantSql と同じ正の条件)を使う。以前は
  //   `kind === "image" && imageKey === null` の否定だけを見ていたため、chatbot(`ApiVariantKind`
  //   に入っているが未実装)を誤って「配信中」扱いにしてしまう抜けがあった。
  const notDeliverableWhileActive = !archived && !isDeliverableKind(kind, imageKey);
  const editing = isDraft || isEditing;
  const destinationUrlOk = isValidHttpsUrl(destinationUrl);
  const altRequired = kind === "image" && buttonLabel.trim() === "";
  const altMissing = altRequired && imageAlt.trim() === "";
  const hasImage = imageKey !== null || pendingFile !== null;
  const imageMissing = kind === "image" && !hasImage;
  const busy = status !== "idle";
  const imageUrl = imageKey !== null ? deliveryImageUrl(imageKey) : null;
  const previewImageUrl = pendingPreviewUrl ?? imageUrl;
  const dirty = isDirtyFrom(baseline, { kind, headline, body, buttonLabel, imageAlt, destinationUrl });

  // 🔴 ページを離れるときの確認(設計上の要件)。既存の `dirty` をそのまま親へ知らせる。
  //   `onDirtyChange` を effect の依存に入れると、親が毎レンダーで新しい関数を渡した場合に
  //   不要な再実行が起きるため、最新の関数は ref で読む(settingsDirtyRef と同じ理由)。
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  // アンマウント時(アーカイブ・削除でカードが一覧から消えるとき)に dirty の記録を残さない。
  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false);
  }, []);

  // 🔴 busy(保存・アップロード・画像削除の進行中)も同じ形で親へ伝える(dirtyとは別の状態)。
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  useEffect(() => {
    return () => onBusyChangeRef.current?.(false);
  }, []);

  /*
    🔴 `_lib/popupEditSession.ts`: 入力中の値・編集モードが変わるたびに親へ知らせ、
    sessionStorage へ保存してもらう。下書き(`editing` は常に true)も既存パターンの編集中
    (`isEditing===true`)も対象——`editing===false` になった瞬間(保存・キャンセル・アンマウント)
    も伝えるので、親側はそのタイミングで持っている分を消すだけでよい(「保存・キャンセルしたら消す」)。
  */
  const liveFields: SyncedFields = { kind, headline, body, buttonLabel, imageAlt, destinationUrl };
  const onLiveChangeRef = useRef(onLiveChange);
  useEffect(() => {
    onLiveChangeRef.current = onLiveChange;
  });
  useEffect(() => {
    onLiveChangeRef.current?.(liveFields, editing, baseline);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveFieldsの各プリミティブ値の変化だけを見る(dirty/busyと同じ理由)
  }, [kind, headline, body, buttonLabel, imageAlt, destinationUrl, editing, baseline]);
  // アンマウント時(保存成功・アーカイブ・削除・下書きのキャンセルでカードが消えるとき)に持ち分を残さない。
  useEffect(() => {
    return () => onLiveChangeRef.current?.(liveFields, false, baseline);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount専用。最新のliveFields/baselineは読まなくてよい(editing=falseだけが効く)
  }, []);

  // オブジェクトURLの後始末
  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  /**
   * 🔴 「何を確定したか」で反映する範囲を分ける判定(`computeSyncPatch`)を
   *   実際に適用する唯一の入口。`patch.fields`/`patch.baseline` が `null` のときは触れない
   *   (画像だけの操作で、文字欄・baselineを上書きしないため)。
   */
  function applyPatch(patch: SyncPatch) {
    if (patch.fields) {
      setKind(patch.fields.kind);
      setHeadline(patch.fields.headline);
      setBody(patch.fields.body);
      setButtonLabel(patch.fields.buttonLabel);
      setImageAlt(patch.fields.imageAlt);
      setDestinationUrl(patch.fields.destinationUrl);
    }
    if (patch.baseline) setBaseline(patch.baseline);
    setImageKey(patch.imageKey);
  }

  /** 「保存」経路(文字欄を送った直後)の patch を作って適用する。baseline も一緒に更新する。 */
  function applySavedVariant(v: ApiVariant) {
    setSavedId(v.id);
    applyPatch(computeSyncPatch({ kind: "save", server: { ...extractSyncedFields(v), imageKey: variantImageKey(v) } }));
  }

  /**
   * 🔴 親から新しい `variant` props が
   *   来たら(他のカードの保存・一覧の再読み込み等)、このカードの表示をそれに合わせる。
   *   ただし **保存・アップロード中(busy)**、または **未保存の変更がある(dirty)** ときは
   *   自分の入力・操作結果を上書きしてしまうため同期しない。下書き(variant===null)も対象外。
   */
  useEffect(() => {
    if (!shouldApplyPropsSync({ hasVariant: variant !== null, busy, dirty })) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 親から来た新しいvariantへ意図的に同期する(dirtyでない場合だけ)
    applySavedVariant(variant as ApiVariant);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- variant.content は毎回新しいオブジェクトなので、その変化だけを見る
  }, [variant?.id, variant?.content, variant?.destinationUrl, variant?.archivedAt, busy, dirty]);

  /**
   * 🔴 「…」メニューの「編集」を押すと
   *   メニュー項目(ボタン)自体がアンマウントされ、キーボード操作者のフォーカスの行き先が
   *   無くなる(ブラウザは既定で `<body>` へ落とす)。表示→編集へ切り替わった瞬間、入力欄の
   *   最初の操作対象へフォーカスを移す(SiteSwitcherの「開いたら最初の項目へ」と同じ考え方)。
   */
  useEffect(() => {
    if (!isEditing) return;
    editableRegionRef.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }, [isEditing]);

  /**
   * 保存(文字欄を送った直後)の後、サーバーが実際に持っている値で画面を置き換える。
   * 🔴 この取得自体が失敗したら呼び出し側は**成功の通知を出さない**
   *   (戻り値で知らせる。黙って諦めない)。
   * 🔴 **文字欄を送っていない経路(画像だけの操作)ではこれを呼ばない**
   *   (`syncImageFromServer` を使う)。ここは「保存」経路専用——呼ぶのは、今の入力をそのまま
   *   サーバーに送った直後だけ(= 送った値と確定する値が一致する前提が成り立つとき)。
   */
  async function syncFromServer(id: string): Promise<boolean> {
    const result = await getJson<ApiVariant>(`/variants/${id}`);
    if (!result.ok) return false;
    applySavedVariant(result.data);
    return true;
  }

  /**
   * 🔴 既存パターンの画像だけの操作(差し替え)の後に `syncFromServer`
   *   (= 文字欄とbaselineも上書きする「保存」の patch)を呼んでいたため、文字欄を編集中(未保存)の
   *   まま画像を差し替えると入力が消えていた。**画像だけを確定した経路では、`computeSyncPatch` に
   *   `{ kind: "image-only" }` を渡し、imageKey だけを反映する(文字欄・baselineには触れない)。**
   */
  async function syncImageFromServer(id: string): Promise<boolean> {
    const result = await getJson<ApiVariant>(`/variants/${id}`);
    if (!result.ok) return false;
    applyPatch(computeSyncPatch({ kind: "image-only", imageKey: variantImageKey(result.data) }));
    return true;
  }

  function selectFile() {
    fileInputRef.current?.click();
  }

  function handleFileChosen(file: File) {
    setError(null);
    if (!isDraft) {
      // 既に保存済みのパターン: このパターン自体は既に有効なレコードなので、差し替えは即アップロードする
      void uploadToExisting(savedId!, file);
      return;
    }
    // 下書き: まだAPIに送らず、画面の中だけで持つ(保存を押すまでアップロードしない)
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(file);
    setPendingPreviewUrl(URL.createObjectURL(file));
  }

  function clearPendingFile() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(null);
    setPendingPreviewUrl(null);
  }

  async function uploadToExisting(id: string, file: File) {
    setStatus("uploading");
    setUploadProgress(0);
    setError(null);
    const result = await uploadVariantImage(id, file, setUploadProgress);
    setUploadProgress(null);
    if (!result.ok) {
      // 🔴 S4バグ修正: 以前はここで `setStatus("idle")` を呼んでいたため、
      //   アップロード自体は成功した直後、`syncImageFromServer`(再取得)がまだ終わっていない間も
      //   画面は busy=false に戻っていた——その短い間にユーザーが保存・差し替え・削除を押せた。
      //   **画像の再取得の成否が確定するまで busy を保つ**(失敗時だけここで早期に idle へ戻す)。
      setStatus("idle");
      setError(imageErrorMessage(result.reason, result.message));
      return;
    }
    // 🔴 画像だけの操作(差し替え)。文字欄・baselineは触らない
    const synced = await syncImageFromServer(id);
    setStatus("idle");
    if (!synced) {
      setError("アップロードはできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
      await onSaved({ silent: true });
      return;
    }
    await onSaved();
  }

  async function removeImage() {
    if (savedId === null || submittingRef.current) return;
    submittingRef.current = true;
    setStatus("removing-image");
    const result = await deleteJson<unknown>(`/variants/${savedId}/image`, {});
    submittingRef.current = false;
    setStatus("idle");
    if (!result.ok) {
      if (result.reason === "last_deliverable_variant") {
        setError(lastDeliverableMessage(result.message));
      } else {
        setError("画像を外せませんでした。もう一度お試しください。");
      }
      return;
    }
    // 🔴 画像だけの操作(外す)。DELETEの結果からimageKeyがnullになったことだけ分かっているので、
    //   それだけを反映する(GETし直さない。文字欄・baselineには触れない)
    applyPatch(computeSyncPatch({ kind: "image-only", imageKey: null }));
    await onSaved();
  }

  /**
   * 配信トグル。OFF→archive・ON→restore。「アーカイブ」という語は画面に出さず、
   * トグルの意味(配信中/停止中)だけで見せる。稼働中のポップから最後の配れるパターンを奪う操作は
   * サーバー側(`last_deliverable_variant`)が拒否するので、その短いエラーをそのまま出す。
   */
  async function toggleDelivery() {
    if (savedId === null || submittingRef.current) return;
    submittingRef.current = true;
    setStatus("toggling-delivery");
    setError(null);
    const action = archived ? "restore" : "archive";
    const result = await postJson<null>(`/variants/${savedId}/${action}`, {});
    submittingRef.current = false;
    setStatus("idle");
    if (!result.ok) {
      setError(variantActionErrorMessage(result));
      return;
    }
    await onSaved();
  }

  /**
   * 「削除」メニューを押した直後。確認ダイアログを開く前に、このパターンの累計(表示・クリック・
   * 閉じた)を取りに行く(`events` は variant 削除で cascade で消えるため、ここで取れた値が
   * 「数字も一緒に消えます」の根拠になる)。開く前の古い値を残さないよう、毎回 null にリセットしてから
   * 取得する(取得失敗時も null=「—」のまま。0にすり替えない)。
   */
  async function openDeleteConfirm() {
    setDeleteStats(null);
    setShowDeleteConfirm(true);
    if (savedId === null) return;
    const result = await getJson<EventCounts>(`/variants/${savedId}/stats`);
    if (result.ok) setDeleteStats(result.data);
  }

  /** 完全に削除。確認は `ConfirmDeleteDialog`(数字も消えることを明示)。 */
  async function handleDeleteVariant() {
    if (savedId === null || submittingRef.current) return;
    submittingRef.current = true;
    setStatus("deleting");
    const result = await deleteJson<unknown>(`/variants/${savedId}`, { confirm: "delete" });
    submittingRef.current = false;
    setStatus("idle");
    setShowDeleteConfirm(false);
    if (!result.ok) {
      // 🔴 失敗(例 last_deliverable_variant の409)でも
      //   確認は閉じるのに、ここだけ focusPatternMenuSoon を呼んでいなかったため、
      //   成功時と違ってフォーカスが body に落ちていた。失敗時も「…」へ戻す。
      setError(variantActionErrorMessage(result));
      focusPatternMenuSoon();
      return;
    }
    await onSaved();
  }

  /** 表示へ戻す(baseline の値に書き戻す)。保存はしない。 */
  function discardEdits() {
    if (baseline) {
      setKind(baseline.kind);
      setHeadline(baseline.headline);
      setBody(baseline.body);
      setButtonLabel(baseline.buttonLabel);
      setImageAlt(baseline.imageAlt);
      setDestinationUrl(baseline.destinationUrl);
    }
    setShowErrors(false);
    setError(null);
    setIsEditing(false);
    // 表示モードへ戻ったので、フォーカスを「…」ボタンへ戻す(未保存なし・確認後の破棄どちらも通る)。
    // 🔴 「変更を破棄」経路は確認モーダル(useFocusTrap)がこの同じ瞬間にアンマウントされ、
    //   その自身の「開く前のフォーカスへ戻す」クリーンアップ(前回フォーカスしていた要素=
    //   もう消えた入力欄やキャンセルボタン)が**この直後に**走って上書きしてしまう
    //   (React のエフェクトのクリーンアップは、この同期ハンドラが終わった後に走るため)。
    //   そのクリーンアップより後に実行されるよう、1tick遅らせて確実に最後に勝たせる。
    focusPatternMenuSoon();
  }

  /**
   * 「…」ボタンへフォーカスを戻す。呼んだ直後ではなく、この呼び出しが起こした再コミットの
   * **後**(`useEffect`)で実行する——`setTimeout` でずらす方式は、busy=false が反映される
   * コミットより先に実行されることがあり(disabled中のボタンへの `.focus` は何もしない)、
   * 実測で確認済み(削除失敗の経路で再現した)。
   */
  function focusPatternMenuSoon() {
    setFocusMenuRequestId((n) => n + 1);
  }
  useEffect(() => {
    if (focusMenuRequestId === 0) return;
    patternMenuRef.current?.focus();
  }, [focusMenuRequestId]);

  /** 「キャンセル」。未保存の変更があれば確認してから表示モードへ戻す。 */
  function handleCancelEdit() {
    if (dirty) {
      setShowCancelConfirm(true);
      return;
    }
    discardEdits();
  }

  async function handleSave() {
    setShowErrors(true);
    if (submittingRef.current) return; // 🔴 同期ラッチで二重送信を防ぐ
    if (!destinationUrlOk) return;
    if (kind === "image" && (imageMissing || altMissing)) return; // ⚠ 保存ボタン自体も無効化している(下の disabled 参照)
    submittingRef.current = true;
    setStatus("saving");
    setError(null);
    const payload = {
      kind,
      content: {
        headline: headline.trim(),
        body: kind === "text" ? body.trim() : "",
        buttonLabel: buttonLabel.trim(),
        imageAlt: kind === "image" ? imageAlt.trim() : "",
      },
      destinationUrl,
    };

    if (isDraft) {
      /*
        🔴 下書きの「保存」を押した直後、POSTが
        まだ進行中の間にページを離れて戻ると、`popupEditSession.ts`に残っていたこの下書きの
        持ち分(sessionStorage)がまだ消えておらず、復元で古い入力ごと復活する——そのころには
        POSTが成功してサーバー側にも同じ内容の本物のパターンが出来ているので、画面には
        **下書き(復元された古い入力)と本物のパターンの両方**が並ぶ(二重表示)。
        **直した方針**: 保存を試す**前**(POSTを呼ぶ前)に、この下書きの持ち分を即座に消す
        (`onLiveChangeRef`を直接呼ぶ。通常の反映用effectとは別に、ここだけ先回りして呼ぶ)。
        POSTが失敗したら(画面がまだこのカードを表示しているなら)元の入力を書き戻す。
      */
      onLiveChangeRef.current?.(liveFields, false, baseline);
      const created = await postJson<{ id: string }>(`/popups/${popupId}/variants`, payload);
      if (!created.ok) {
        submittingRef.current = false;
        setStatus("idle");
        onLiveChangeRef.current?.(liveFields, true, baseline); // 書き戻す(まだ下書きのまま)
        if (created.reason === "last_deliverable_variant") {
          setError(lastDeliverableMessage(created.message));
        } else {
          const field = created.field ? FIELD_LABELS[created.field] ?? created.field : null;
          setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        }
        return;
      }
      const id = created.data.id;
      if (kind === "image" && pendingFile) {
        setStatus("uploading");
        setUploadProgress(0);
        const uploaded = await uploadVariantImage(id, pendingFile, setUploadProgress);
        setUploadProgress(null);
        if (!uploaded.ok) {
          /*
            🔴 「失敗したら消す」の結果を確かめずに握りつぶしていた
            (404・409・通信失敗を無視)。まずGETで実際の状態を確かめてから、消す/消さないを決める
            (`recoverFailedImageUpload`。詳細はファイル先頭のコメントと variantRecovery.ts 参照)。
          */
          const outcome = await recoverFailedImageUpload(id, {
            getVariant: (vid) => getJson<ApiVariant>(`/variants/${vid}`),
            deleteVariant: (vid) => deleteJson<unknown>(`/variants/${vid}`, { confirm: "delete" }),
          });
          submittingRef.current = false;
          setStatus("idle");
          if (outcome.kind === "recovered") {
            // 応答だけが失われていた。実際には成功していたので、保存済みとして同期する(成功の通知は出さない)
            clearPendingFile();
            applySavedVariant(outcome.variant);
            await onSaved({ silent: true });
            return;
          }
          if (outcome.kind === "reverted-to-draft") {
            // 画像が無いことを確認し、補償DELETEも成功した。まっさらな下書きに戻す(書き戻す)。
            onLiveChangeRef.current?.(liveFields, true, baseline);
            setError(imageErrorMessage(uploaded.reason, uploaded.message));
            return;
          }
          // kept-without-image / unknown: 作ったIDを手放さない。保存済み・画像なしとして再同期する
          //   (これは「保存」経路——送った文字欄がサーバーに通ったので、文字欄・baselineごと揃えてよい)
          clearPendingFile();
          setSavedId(id);
          applyPatch(
            computeSyncPatch({
              kind: "save",
              server: {
                kind: payload.kind,
                headline: payload.content.headline,
                body: payload.content.body,
                buttonLabel: payload.content.buttonLabel,
                imageAlt: payload.content.imageAlt,
                destinationUrl: payload.destinationUrl,
                imageKey: null,
              },
            }),
          );
          setError(outcome.message);
          await onSaved({ silent: true });
          return;
        }
      }
      clearPendingFile();
      setSavedId(id);
      const synced = await syncFromServer(id);
      submittingRef.current = false;
      setStatus("idle");
      if (!synced) {
        setError("保存はできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
        await onSaved({ silent: true });
        return;
      }
      await onSaved();
      return;
    } else {
      const result = await putJson<unknown>(`/variants/${savedId}`, payload);
      if (!result.ok) {
        submittingRef.current = false;
        setStatus("idle");
        if (result.reason === "last_deliverable_variant") {
          setError(lastDeliverableMessage(result.message));
        } else {
          const field = result.field ? FIELD_LABELS[result.field] ?? result.field : null;
          setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        }
        return;
      }
      const synced = await syncFromServer(savedId as string);
      submittingRef.current = false;
      setStatus("idle");
      if (!synced) {
        setError("保存はできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
        await onSaved({ silent: true });
        return;
      }
    }

    // 🔴 既存パターンの更新が成功した経路だけがここに来る(下書きは上で既に return している)。
    //   保存できたので表示モードへ戻す。フォーカスは「…」ボタンへ。
    setIsEditing(false);
    focusPatternMenuSoon();
    await onSaved();
  }

  const saveDisabled = busy || (kind === "image" && (imageMissing || (showErrors && altMissing)));
  const deleteDialogName = headline.trim() !== "" ? headline.trim() : kind === "image" ? "画像のパターン" : "テキストのパターン";

  /*
    🔴 確認: 画像型で画像が無いとき、プレビューは「画像の無い小さな箱」になり、
    閉じる×がボタンの文言に重なっていた——`buildPopupView` は `<img>` に `src` を付けない間、
    画像の高さが確保されず(`height:auto`・intrinsicサイズ無し)、絶対配置の閉じる×だけが
    パネルの小さな実高さの上に乗ってフッターと重なる。画像を読み込めなかったのではなく、
    管理画面側がそもそも画像を持っていない(下書き段階・まだ選んでいない)ときに必ず起きる形。
    直し方は「無駄なものは出さない」原則どおり、見せる画像が無い間はプレビュー欄そのものを
    出さない(崩れた表示を見せるより、何も見せない方が誤解を生まない)。
  */
  const canPreview = kind !== "image" || previewImageUrl !== null;
  const previewPane = canPreview ? (
    <PopupPreviewPane
      kind={kind}
      headline={headline}
      body={body}
      buttonLabel={buttonLabel}
      imageAlt={imageAlt}
      destinationUrl={destinationUrl}
      imageUrl={kind === "image" ? previewImageUrl : null}
    />
  ) : null;

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {isDraft ? (
            <div className="flex items-center gap-1 rounded-full border border-line p-0.5 text-xs font-medium">
              <button
                type="button"
                aria-pressed={kind === "text"}
                onClick={() => setKind("text")}
                className={`rounded-full px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  kind === "text" ? "bg-ink text-paper" : "text-ink/60"
                }`}
              >
                テキスト
              </button>
              <button
                type="button"
                aria-pressed={kind === "image"}
                onClick={() => setKind("image")}
                className={`rounded-full px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  kind === "image" ? "bg-ink text-paper" : "text-ink/60"
                }`}
              >
                画像
              </button>
            </div>
          ) : (
            <span className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink/60">
              {kind === "image" ? "画像" : "テキスト"}
            </span>
          )}
          {!isDraft && (
            <DeliveryToggle
              active={!archived}
              disabled={busy}
              label="このパターンの配信"
              onLabel="配信中"
              offLabel="停止中"
              activeLabelOverride={notDeliverableWhileActive ? "配信できません" : undefined}
              onToggle={toggleDelivery}
            />
          )}
        </div>
        <div className="flex items-center gap-4 text-sm font-medium">
          {!isDraft && (
            <PatternMenu
              ref={patternMenuRef}
              label="このパターンの操作"
              disabled={busy}
              hideEdit={isEditing}
              onEdit={() => setIsEditing(true)}
              onDelete={() => void openDeleteConfirm()}
            />
          )}
        </div>
      </div>

      {error && <div className="mb-4"><FieldError id={`variant-error-${savedId ?? "draft"}`} message={error} /></div>}

      {!editing ? (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          {kind === "text" ? (
            <div className="grid flex-1 grid-cols-2 gap-5">
              {headline.trim() !== "" && <ReadOnlyField label="見出し" value={headline} />}
              {buttonLabel.trim() !== "" && <ReadOnlyField label="ボタン文言" value={buttonLabel} />}
              {body.trim() !== "" && (
                <div className="col-span-2">
                  <ReadOnlyField label="本文" value={body} />
                </div>
              )}
              <div className="col-span-2">
                <ReadOnlyField label="遷移先URL" value={destinationUrl} mono />
              </div>
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-1 gap-5">
              <div>
                <div className="mb-1 text-xs font-medium text-ink/60">画像</div>
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-paper flex items-center justify-center text-ink/25">
                  {imageUrl !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 静的書き出しのため next/image の最適化サーバーが無い
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      <circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M21 16l-5.5-5.5a2 2 0 00-2.8 0L4 19" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  )}
                </div>
              </div>
              {imageAlt.trim() !== "" && <ReadOnlyField label="画像の説明" value={imageAlt} />}
              {buttonLabel.trim() !== "" && <ReadOnlyField label="ボタン文言" value={buttonLabel} />}
              <ReadOnlyField label="遷移先URL" value={destinationUrl} mono />
            </div>
          )}
          {previewPane}
        </div>
      ) : (
        <div ref={editableRegionRef}>
        {kind === "text" ? (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="grid flex-1 grid-cols-2 gap-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">見出し</label>
            <input
              type="text"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">ボタン文言</label>
            <input
              type="text"
              value={buttonLabel}
              onChange={(e) => setButtonLabel(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-ink">本文</label>
            <textarea
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-ink">遷移先URL</label>
            <input
              type="text"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              disabled={busy}
              aria-invalid={showErrors && !destinationUrlOk}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 font-mono text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && !destinationUrlOk && (
              <FieldError id="dest-url-error-text" message="https:// から始まるURLを入力してください" />
            )}
          </div>
        </div>
        {previewPane}
        </div>
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="grid flex-1 grid-cols-1 gap-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">画像</label>
            {status === "uploading" ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3">
                <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-surface opacity-40" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-xs text-ink/60">
                    <span>アップロード中…</span>
                    <span>{uploadProgress ?? 0}%</span>
                  </div>
                  {/*
                    🔴 CSP(管理画面)で style-src に unsafe-inline を許していないため、
                    幅を `style={{ width }}` で動かす実装は使えない(React の inline style は
                    CSP の style-src の対象。ブラウザの実装依存を避け、unsafe-inline 無しで
                    動的な見た目を変える手段として `<progress>` の value/max 属性を使う。
                    見た目は globals.css の `.upload-progress` で元のdiv実装に揃えている。
                    副次的に、ネイティブの role=progressbar + aria-valuenow が付く(a11yの改善)。
                  */}
                  <progress
                    className="upload-progress h-1.5 w-full"
                    value={uploadProgress ?? 0}
                    max={100}
                    aria-label="アップロードの進捗"
                  />
                </div>
              </div>
            ) : hasImage ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3">
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-surface">
                  {pendingPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 静的書き出しのため next/image の最適化サーバーが無い
                    <img src={pendingPreviewUrl} alt="" className="h-full w-full object-cover" />
                  ) : imageUrl !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 同上。配信元は別オリジン(delivery Worker)
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] text-ink/40">
                      配信元URL未設定
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {pendingPreviewUrl && (
                    <div className="mb-1 font-mono text-xs text-ink/60">保存時にアップロードされます</div>
                  )}
                  <div className="flex items-center gap-4 text-sm font-medium">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={selectFile}
                      className="text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      差し替え
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={pendingPreviewUrl ? clearPendingFile : removeImage}
                      className="text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      外す
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4 rounded-lg border border-dashed border-line bg-paper px-4 py-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink/25">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M21 16l-5.5-5.5a2 2 0 00-2.8 0L4 19" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </div>
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={selectFile}
                    className="text-sm font-medium text-ink hover:underline disabled:cursor-not-allowed disabled:text-ink/40 disabled:no-underline
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    画像を選択
                  </button>
                  <div className="mt-1 font-mono text-xs text-ink/60">
                    PNG / JPEG / GIF / WebP・画像2MB・GIF3MBまで・長辺2,400pxまで
                  </div>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) handleFileChosen(file);
              }}
            />
          </div>

          <div>
            <label htmlFor={`alt-${savedId ?? "draft"}`} className="mb-1.5 block text-sm font-medium text-ink">
              画像の説明 {altRequired && <span className="text-danger">*</span>}{" "}
              <span className="font-normal text-ink/60">(スクリーンリーダー用{altRequired ? "" : "・任意"})</span>
            </label>
            <input
              id={`alt-${savedId ?? "draft"}`}
              type="text"
              value={imageAlt}
              onChange={(e) => setImageAlt(e.target.value)}
              disabled={busy}
              placeholder="例: 秋の新作キャンペーンの商品写真"
              aria-invalid={showErrors && altMissing}
              aria-describedby={showErrors && altMissing ? `alt-error-${savedId ?? "draft"}` : undefined}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && altMissing ? (
              <FieldError id={`alt-error-${savedId ?? "draft"}`} message="画像の説明を入力してください(ボタン文言が空のときは必須です)" />
            ) : (
              <div className="mt-1.5 text-xs text-ink/60">
                {altRequired
                  ? "ボタン文言が空のため必須です(画像だけのリンクでは、これが唯一の読み上げ内容になります)。"
                  : "ボタン文言があるので、ここは空でも読み上げられます。"}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">
                見出し <span className="font-normal text-ink/60">(任意)</span>
              </label>
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                disabled={busy}
                placeholder="未入力なら画像のみ表示"
                className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">
                ボタン文言 <span className="font-normal text-ink/60">(任意)</span>
              </label>
              <input
                type="text"
                value={buttonLabel}
                onChange={(e) => setButtonLabel(e.target.value)}
                disabled={busy}
                placeholder="空なら画像だけのバナーになります"
                className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
              <div className="mt-1.5 font-mono text-xs text-ink/60">
                表示: {buttonLabel.trim() === "" ? "画像のみ(タップで遷移)" : "画像+ボタン"}
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">遷移先URL</label>
            <input
              type="text"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              disabled={busy}
              placeholder="https://"
              aria-invalid={showErrors && !destinationUrlOk}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 font-mono text-sm text-ink placeholder:text-ink/35
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && !destinationUrlOk && (
              <FieldError id="dest-url-error-image" message="https:// から始まるURLを入力してください" />
            )}
          </div>
        </div>
        {previewPane}
        </div>
        )}
        </div>
      )}

      {/*
        🔴 既存パターンの編集中・下書き(どちらも常に入力欄=`editing`)は、カードの右下に
        「キャンセル」+「保存」を置く(下書きの「取り消す/保存」が右上にあったのを、既存パターンの
        編集モードと同じ右下の位置・文言(「キャンセル」)に揃えた)。下書きのキャンセルの動き
        (確認なしで即座に取り消す。未保存の入力が確認なしで消えても、下書き自体がまだAPIに
        何も送っていない「空の枠」だから=削除確認が要るものを消すわけではない)は変えていない
        ——`handleCancelEdit`(未保存なら確認モーダルを出す)は既存パターンの編集だけが使う。
      */}
      {editing && (
        <div className="mt-5 flex items-center justify-end gap-4">
          {isDraft
            ? onCancelDraft && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearPendingFile();
                    onCancelDraft();
                  }}
                  className={`text-sm font-medium text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                >
                  キャンセル
                </button>
              )
            : (
              <button
                type="button"
                disabled={busy}
                onClick={handleCancelEdit}
                className={`text-sm font-medium text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2
                           focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
              >
                キャンセル
              </button>
            )}
          <button
            type="button"
            disabled={saveDisabled}
            onClick={handleSave}
            className="h-9 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                       disabled:cursor-not-allowed disabled:bg-ink/30
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {status === "saving" ? "保存中…" : "保存"}
          </button>
        </div>
      )}

      {showCancelConfirm && (
        <Modal titleId={cancelTitleId} descriptionId={cancelDescId} onClose={() => setShowCancelConfirm(false)}>
          <h2 id={cancelTitleId} className="mb-3 text-base font-semibold text-ink">
            編集を終了しますか
          </h2>
          <p id={cancelDescId} className="mb-6 text-sm leading-relaxed text-ink/70">
            保存していない変更は失われます。
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCancelConfirm(false)}
              className="h-10 rounded-lg px-4 text-sm font-medium text-ink/60 hover:bg-paper
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              編集を続ける
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCancelConfirm(false);
                discardEdits();
              }}
              className="h-10 rounded-lg bg-danger px-4 text-sm font-semibold text-paper hover:bg-danger/90
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
            >
              変更を破棄
            </button>
          </div>
        </Modal>
      )}

      {showDeleteConfirm && (
        <ConfirmDeleteDialog
          name={deleteDialogName}
          stats={deleteConfirmVariantStatsText(deleteStats)}
          onCancel={() => {
            setShowDeleteConfirm(false);
            focusPatternMenuSoon();
          }}
          onConfirm={handleDeleteVariant}
        />
      )}
    </div>
  );
}
