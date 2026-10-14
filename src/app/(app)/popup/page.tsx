"use client";

/*
  デザイン > キャンペーンの詳細。
  🔴 「出すきっかけ」「頻度」はここから外した(表示設定 `/display` に移した)。
  🔴 キャンペーン名は常時入力欄にしない——見出し表示+横の編集アイコン(四角+鉛筆)を押したときだけ
    入力状態に切り替わる。
  🔴 パターンのカード(`VariantCard`)は表示/編集の切り替え+「…」メニュー+
    配信トグル+プレビューに作り替えた。配信トグル(archive/restore)・完全削除は `VariantCard` が
    自前でAPIを呼ぶため、ここは一覧の再読み込み(`onSaved`)だけを持つ。アーカイブ済みのパターンも
    一覧から消さず、トグルOFFのカードとして残す(非アーカイブの件数だけを上限カウントに使う)。

  🔴 全ページの移動をソフト遷移にする変更で、この画面も出入りのフルリロードの境界
    (`navigationBoundary.ts`)を外した。代わりに、編集中の入力(キャンペーン名・パターンの編集
    モード・下書き)を `_lib/popupEditSession.ts`(sessionStorage)に保存し、ページを離れて
    戻ってきたら復元する——「確認がなくても入力が消えない」作りにしたので、サイドバー等での
    離脱確認(`onBeforeLeave`・`UnsavedChangesDialog`)は不要になった。**タブを閉じる・
    外部へ移る・再読み込みの `beforeunload` だけは残す**(sessionStorageはタブを閉じると消えるため)。
*/
import { Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getJson, putJson } from "../../_lib/api";
import { ApiPopup, ApiVariant, VARIANT_LIMIT } from "../../_lib/types";
import { Loading } from "../../_components/Loading";
import { ErrorBanner } from "../../_components/ErrorBanner";
import { Toast } from "../../_components/Toast";
import { VariantCard } from "../../_components/VariantCard";
import { CheckIcon, EditIcon, IconButton, XIcon } from "../../_components/IconButton";
import { useSessionState } from "../../_lib/sessionContext";
import { useAppShellOverride } from "../../_lib/appShellOverride";
import { useBeforeUnloadGuard } from "../../_lib/unsavedChanges";
import { nextLoadErrorState } from "../../_lib/pageLoad";
import { toggleInSet } from "../../_lib/toggleSet";
import { createLatestWinsGuard, fetchLatestWins } from "../../_lib/latestWins";
import { extractSyncedFields, isDirtyFrom, type SyncedFields } from "../../_lib/variantSync";
import {
  EMPTY_POPUP_EDIT_SNAPSHOT,
  loadPopupEditSnapshot,
  persistableDraftOrder,
  savePopupEditSnapshot,
  type PersistedCard,
  type PersistedName,
} from "../../_lib/popupEditSession";

/** キャンペーン名の見出し(読むだけ)+ 鉛筆(押したときだけ入力状態に切り替わる)。 */
function CampaignNameHeading({
  name,
  popupId,
  onRenamed,
  onDirtyChange,
  onBusyChange,
  initialEditingValue,
  onLiveChange,
}: {
  name: string;
  popupId: string;
  onRenamed: (name: string) => void;
  /*
    🔴 編集中(未保存)の名前が、既存の未保存確認の対象から
    外れていた。`VariantCard` の `onDirtyChange`/`onBusyChange` と同じ形で親(`PopupContent`)へ
    知らせるだけで、新しい判定は作らない(今は `beforeunload`=タブを閉じる・外部へ移る・
    再読み込みの判定にだけ使う。サイドバー等の離脱確認はsessionStorageの復元に置き換えた)。
  */
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  /** `_lib/popupEditSession.ts` からの復元。編集中だった入力値(編集していなければ undefined/null)。 */
  initialEditingValue?: string | null;
  /**
   * 編集モード・入力値が変わるたびに親へ知らせる(sessionStorageへ保存するため)。`baseline` は
   * 「編集を始めた時点でサーバーから見えていた名前」。
   * 🔴 以前は`name` propをそのままbaselineとして渡していたが、
   *   「`name`は編集中は変わらない」という前提が誤っていた——`popup/page.tsx`の`load()`は
   *   reloadErrorの再読み込みボタン等から**編集中でも**再実行され、`setPopup`で`name`propを
   *   新しい値に差し替えることがある。その瞬間にこの効果が再実行され、baselineが黙って
   *   新しい値に進んでしまうと、「編集を始めた時点の値」という意味が崩れ、discardの判定が
   *   効かなくなる(サーバー値が変わったのに気づかない)。**編集を始めた瞬間の`name`を
   *   `editBaseline`に固定して持ち、以後`name`が変わってもbaselineは動かさない。**
   */
  onLiveChange?: (state: { editing: boolean; value: string; baseline: string }) => void;
}) {
  const hasRestoredValue = initialEditingValue !== undefined && initialEditingValue !== null;
  const [editing, setEditing] = useState(hasRestoredValue);
  const [value, setValue] = useState(hasRestoredValue ? (initialEditingValue as string) : name);
  // 🔴 復元のときは、親が既に「持っていたbaseline===今のname」を確認済みなので、
  //   マウント時点の`name`をそのままbaselineにしてよい(startEditでの再設定は上書きしない)。
  const [editBaseline, setEditBaseline] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  // dirty = 編集中で、今の入力が保存済みの名前と違う(VariantCardのisDirtyFromと同じ考え方)
  const dirty = editing && value.trim() !== name;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(saving);
  }, [saving, onBusyChange]);
  // アンマウント時に dirty/busy の記録を残さない(VariantCardと同じ)
  useEffect(() => {
    return () => {
      onDirtyChange(false);
      onBusyChange(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount専用。最新のonDirtyChange/onBusyChangeは呼ばなくてよい
  }, []);

  // 🔴 `popupEditSession.ts` への保存。editing=falseになったとき(保存・キャンセル)は親が消す。
  const onLiveChangeRef = useRef(onLiveChange);
  useEffect(() => {
    onLiveChangeRef.current = onLiveChange;
  });
  useEffect(() => {
    onLiveChangeRef.current?.({ editing, value, baseline: editBaseline });
  }, [editing, value, editBaseline]);
  useEffect(() => {
    return () => onLiveChangeRef.current?.({ editing: false, value: "", baseline: editBaseline });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount専用。editing:falseだけが効く
  }, []);

  function startEdit() {
    setValue(name);
    setEditBaseline(name); // 🔴 編集を始めた「今」のnameで固定する(以後nameが変わっても動かさない)
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    const trimmed = value.trim();
    if (trimmed === "" || saving) return;
    setSaving(true);
    const result = await putJson<null>(`/popups/${popupId}/name`, { name: trimmed });
    setSaving(false);
    if (!result.ok) {
      setError("保存できませんでした。もう一度お試しください。");
      return;
    }
    onRenamed(trimmed);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="mb-8 flex items-center gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <IconButton as="button" label="キャンペーン名を編集" icon={EditIcon} onClick={startEdit} />
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="flex max-w-sm items-center gap-1.5">
        <label htmlFor={inputId} className="sr-only">
          キャンペーン名
        </label>
        <input
          id={inputId}
          type="text"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") cancel();
          }}
          className="h-11 flex-1 rounded-lg border border-line bg-surface px-3.5 text-xl font-semibold text-ink
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />
        <IconButton as="button" label="保存" icon={CheckIcon} disabled={saving || value.trim() === ""} onClick={() => void save()} />
        <IconButton as="button" label="キャンセル" icon={XIcon} disabled={saving} onClick={cancel} />
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function PopupContent() {
  const sessionState = useSessionState();
  const params = useSearchParams();
  const popupId = params.get("id") ?? "";

  const [popup, setPopup] = useState<ApiPopup | null>(null);
  const [variants, setVariants] = useState<ApiVariant[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // 🔴 一度表示した後の再取得の失敗で編集画面全体をエラー画面に置き換えない
  //   (全VariantCardがアンマウントされ、未保存の入力が消えるため)。
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);

  const [toast, setToast] = useState<string | null>(null);
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const [variantActionError, setVariantActionError] = useState<string | null>(null);
  const [dirtyVariantIds, setDirtyVariantIds] = useState<ReadonlySet<string>>(new Set());
  const setVariantDirty = useCallback((variantId: string, dirty: boolean) => {
    setDirtyVariantIds((prev) => toggleInSet(prev, variantId, dirty));
  }, []);

  const [busyCardIds, setBusyCardIds] = useState<ReadonlySet<string>>(new Set());
  const setCardBusy = useCallback((cardId: string, busy: boolean) => {
    setBusyCardIds((prev) => toggleInSet(prev, cardId, busy));
  }, []);

  // 🔴 キャンペーン名の編集中(未保存)も対象に含める
  const [nameDirty, setNameDirty] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);

  const hasUnsavedChanges = dirtyVariantIds.size > 0 || draftKeys.length > 0 || nameDirty;
  const isBusy = busyCardIds.size > 0 || nameBusy;
  const blocksLeaving = hasUnsavedChanges || isBusy;
  // 🔴 サイドバー等の離脱確認(`onBeforeLeave`・`UnsavedChangesDialog`)は撤去した
  //   (編集中の入力は下の sessionStorage 復元で保たれるので、確認そのものが不要になった)。
  //   `beforeunload`(タブを閉じる・外部へ移る・再読み込み。sessionStorage はタブを閉じると
  //   消えるため、この経路だけはまだ意味がある)だけを残す。
  useBeforeUnloadGuard(blocksLeaving);

  /*
    🔴 `_lib/popupEditSession.ts` からの復元。`popupId` 確定時に一度だけ
    sessionStorage を読む。`useState` の遅延初期化(ref ではなく state——react-hooks/refs:
    ref を render 中に読み書きしてはいけない)で、`popupId` が初回描画時点で既に確定している
    通常ケースはここで即座に読む。`popupId` が初回に空(=未確定)だった場合だけ、下の effect で
    確定後に読み直す。`load()`(ネットワーク)より確実に先に終わる同期処理なので、`variants` が
    届く前にこの state が埋まっている(下の variants.map 参照)。
  */
  const [restored, setRestored] = useState<typeof EMPTY_POPUP_EDIT_SNAPSHOT>(() =>
    popupId === "" ? EMPTY_POPUP_EDIT_SNAPSHOT : loadPopupEditSnapshot(popupId),
  );
  const restoredForPopupIdRef = useRef(popupId);
  useEffect(() => {
    if (popupId === "" || popupId === restoredForPopupIdRef.current) return;
    restoredForPopupIdRef.current = popupId;
    setRestored(loadPopupEditSnapshot(popupId));
  }, [popupId]);
  const draftOrderAppliedRef = useRef(false);
  useEffect(() => {
    if (draftOrderAppliedRef.current || restored.draftOrder.length === 0) return;
    draftOrderAppliedRef.current = true;
    setDraftKeys(restored.draftOrder);
  }, [restored]);

  // 🔴 子(CampaignNameHeading・VariantCard)からの編集中の値を集約し、sessionStorageへ書く。
  const [persistedName, setPersistedName] = useState<PersistedName | null>(null);
  const [cardFields, setCardFields] = useState<Record<string, PersistedCard>>({});
  const setCardLive = useCallback((cardId: string, fields: SyncedFields, editing: boolean, baseline: SyncedFields | null) => {
    setCardFields((prev) => {
      if (!editing) {
        if (!(cardId in prev)) return prev;
        const next = { ...prev };
        delete next[cardId];
        return next;
      }
      return { ...prev, [cardId]: { baseline, fields } };
    });
  }, []);

  useEffect(() => {
    if (popupId === "") return;
    // 🔴 `draftKeys`(カードが画面に残っている間は
    //   変えない枠)をそのまま保存すると、保存を試している最中のカード(`cardFields`からは
    //   先回りして消えている)が「中身の無い空の下書き枠」として復元されてしまう。
    //   `persistableDraftOrder`(`_lib/popupEditSession.ts`)で、持ち分が実在するキーだけに絞る。
    savePopupEditSnapshot(popupId, { name: persistedName, draftOrder: persistableDraftOrder(draftKeys, cardFields), cards: cardFields });
  }, [popupId, persistedName, draftKeys, cardFields]);

  /*
    🔴 `PopupPage`(下)が `id` が変わるたびに `key` で丸ごと作り直すので、
    「違うキャンペーンの応答がこの画面に紛れ込む」ことは無くなった(古いidの応答は、古い
    コンポーネントインスタンス自体が既にアンマウント済みなので届いても反映されない)。ここで
    `createLatestWinsGuard`(`popups/page.tsx`と同じ考え方)を使うのは、**同じid**のまま
    (再読み込みボタンの連打等で)`load()`が重複して発行されたときに、古い方の応答が後から
    届いて新しい方の応答を上書きしないようにするため。
  */
  const loadGuardRef = useRef(createLatestWinsGuard());
  const load = useCallback(async () => {
    if (popupId === "") return;
    await fetchLatestWins(
      loadGuardRef.current,
      () => getJson<{ popup: ApiPopup; variants: ApiVariant[] }>(`/popups/${popupId}`),
      () => {},
      (popupResult) => {
        if (!popupResult.ok) {
          const next = nextLoadErrorState(false, loadedOnceRef.current);
          setLoadError(next.loadError);
          setReloadError(next.reloadError);
          return;
        }
        setLoadError(false);
        setReloadError(false);
        loadedOnceRef.current = true;
        setPopup(popupResult.data.popup);
        setVariants(popupResult.data.variants);
      },
    );
  }, [popupId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  // 🔴 上限(VARIANT_LIMIT)はサーバーのトリガーと同じく「非アーカイブの件数」で数える
  //   (アーカイブ済みは一覧にカードとして残るが上限には数えない)。
  const activeVariantCount = variants?.filter((v) => v.archivedAt === null).length ?? 0;
  const remainingSlots = Math.max(0, VARIANT_LIMIT - activeVariantCount - draftKeys.length);
  /*
    🔴 以前はURLの `?site=`(一覧からのリンクが付けていた手がかり)を
    確認せずに使っていた。popup本体の取得が済んで `popup.siteId` が分かるまでは **サイトが
    未確定**として扱う(`siteId=""`)——`Sidebar.tsx` の `NavLink` は `siteId=""` のとき非活性に
    なるので、表示設定・タグの設置等のサイト依存リンクは取得が終わるまで押せない。取得後は
    `popup.siteId` だけを使う(URLの手がかりと食い違っていても、確定値を優先して使う)。
    取得に失敗した場合は `popup` が `null` のままなので `siteId` も `""` のまま
    =誤ったサイトへのリンクが残らない。
  */
  const siteId = popup?.siteId ?? "";
  // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` に1回だけある。本体の取得が終わるまでURLに
  //   siteId が無いため、確定した siteId をcontext経由で知らせる(appShellOverride.tsx・
  //   appShellRoute.ts参照)。onBeforeLeave はもう渡さない(ファイル先頭のコメント参照)。
  useAppShellOverride({ siteId });

  return (
    // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` が1回だけ描く。ここはその中身(children)だけ。
    <>
      {popupId === "" ? (
          <ErrorBanner message="キャンペーンが指定されていません。" />
        ) : sessionState !== "ready" ? (
          <Loading label="確認中" />
        ) : loadError ? (
          <ErrorBanner message="キャンペーンを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />
        ) : popup === null || variants === null ? (
          <Loading label="キャンペーンを読み込み中" />
        ) : (
          <>
            {reloadError && (
              <div className="mb-6">
                <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
              </div>
            )}

            <CampaignNameHeading
              name={popup.name}
              popupId={popup.id}
              onRenamed={(name) => setPopup((p) => (p ? { ...p, name } : p))}
              onDirtyChange={setNameDirty}
              onBusyChange={setNameBusy}
              // 🔴 名前も他のパターンと同じ理由でdiscardする: 持っていたbaseline(編集を始めた時点の
              //   名前)と、今読み込んだ最新の `popup.name` が食い違っていたら復元しない。
              initialEditingValue={restored.name !== null && restored.name.baseline === popup.name ? restored.name.value : null}
              onLiveChange={(state) => setPersistedName(state.editing ? { baseline: state.baseline, value: state.value } : null)}
            />

            <section>
              <div className="mb-3 flex items-end justify-between">
                <h2 className="text-base font-semibold tracking-tight">パターン</h2>
                <span className="font-mono text-xs text-ink/60">
                  {activeVariantCount} / {VARIANT_LIMIT}
                </span>
              </div>

              {variantActionError && (
                <div className="mb-4">
                  <ErrorBanner message={variantActionError} />
                </div>
              )}

              <div className="space-y-4">
                {/*
                  🔴 アーカイブ済みのパターンも配信トグル(左上)付きのカードのまま並べる
                  (別枠に隠さない)。配信トグル・削除・編集(入力欄への切り替え)はすべて `VariantCard` が
                  自前で API を呼ぶ(保存・画像操作と同じ作り)。ここは `onSaved` で一覧を再読み込みするだけ。
                */}
                {variants.map((variant) => {
                  /*
                    🔴 復元の可否(`_lib/popupEditSession.ts` 先頭のコメント参照): 持っていた
                    baseline(編集を始めた時点でサーバーから見えていた値)と、今読み込んだ
                    `variant` の値が食い違っていたら、その間にサーバーの値が変わったとみなして
                    discard する(復元しない。古い入力で上書き保存する事故を避ける)。
                  */
                  const persisted = restored.cards[variant.id] ?? null;
                  const freshFields = extractSyncedFields(variant);
                  const serverChanged = persisted !== null && persisted.baseline !== null && isDirtyFrom(persisted.baseline, freshFields);
                  const useRestore = persisted !== null && !serverChanged;
                  return (
                    <VariantCard
                      key={variant.id}
                      variant={variant}
                      popupId={popupId}
                      onSaved={async (opts) => {
                        await load();
                        if (opts?.errorMessage) setVariantActionError(opts.errorMessage);
                        else if (!opts?.silent) setToast("変更を保存しました");
                      }}
                      onCancelDraft={null}
                      onDirtyChange={(dirty) => setVariantDirty(variant.id, dirty)}
                      onBusyChange={(busy) => setCardBusy(variant.id, busy)}
                      initialEditing={useRestore}
                      initialFields={useRestore ? persisted.fields : null}
                      onLiveChange={(fields, editing, baseline) => setCardLive(variant.id, fields, editing, baseline)}
                    />
                  );
                })}

                {draftKeys.map((key) => {
                  const persisted = restored.cards[key] ?? null;
                  return (
                    <VariantCard
                      key={key}
                      variant={null}
                      popupId={popupId}
                      onSaved={async (opts) => {
                        setDraftKeys((keys) => keys.filter((k) => k !== key));
                        await load();
                        if (opts?.errorMessage) setVariantActionError(opts.errorMessage);
                        else if (!opts?.silent) setToast("変更を保存しました");
                      }}
                      onCancelDraft={() => setDraftKeys((keys) => keys.filter((k) => k !== key))}
                      onBusyChange={(busy) => setCardBusy(key, busy)}
                      initialFields={persisted?.fields ?? null}
                      onLiveChange={(fields, editing, baseline) => setCardLive(key, fields, editing, baseline)}
                    />
                  );
                })}

                {/*
                  🔴 確認: 残り枠の数だけ「+ パターンを追加」を並べていたのは誤り
                  (モックは常に1個だけ)。押すたびに下書きが1枚増え、上限に達したら隠す。
                */}
                {remainingSlots > 0 && (
                  <button
                    type="button"
                    onClick={() => setDraftKeys((keys) => [...keys, `draft-${Date.now()}-${Math.random()}`])}
                    className="flex w-full items-center justify-center rounded-xl border border-dashed border-line py-6 text-sm font-medium text-ink/60 hover:border-ink/30 hover:text-ink/60
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    + パターンを追加
                  </button>
                )}
              </div>
            </section>
          </>
        )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}

/*
  🔴 `?id=` が変わっても(同じ`/popup`ルートへのソフト遷移)、
  `PopupContent` は同じコンポーネントインスタンスのまま——Reactは「同じ場所の同じ型」を
  再利用し、`id`の変化は`useSearchParams()`の戻り値が変わるだけで、ローカルstate
  (`draftKeys`・`dirtyVariantIds`・`restored`等)は前のキャンペーンの分がそのまま残る。
  `key={popupId}` を付けて、idが変わったら**別のコンポーネントとして丸ごと作り直す**
  (全stateが初期値に戻る。popupEditSessionの復元もpopupId単位なので、作り直しても
  正しいキャンペーンの分だけを読む)。
*/
function PopupIdGate() {
  const params = useSearchParams();
  const popupId = params.get("id") ?? "";
  return <PopupContent key={popupId} />;
}

export default function PopupPage() {
  return (
    <Suspense fallback={null}>
      <PopupIdGate />
    </Suspense>
  );
}
