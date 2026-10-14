"use client";

/*
  デザイン > キャンペーンの一覧(v6案A)。
  🔴 サイドバーの名前は「デザイン」。中身(このファイル)は旧「ポップ管理」のままで良い——
    URL(`/popups`)もサーバー側のエンドポイントも変えない(方針どおり)。

  変更点(原則「基本的に無駄なものは表示しない」):
  - 数値列(表示/クリック/閉じた)を外す(数字はダッシュボードで見る)
  - 「操作」の見出しは `sr-only` にする(列自体は残す=削除ボタンの置き場所)
  - 編集ボタンを外し、行全体(配信トグル・削除を除く)をクリック/Enter/Spaceでキャンペーンの中へ
  - 「+ ポップを追加」→「+ 追加」
  - アーカイブを廃止。配信トグル+削除(確認ダイアログで「数字も消える」を明示)だけにする
  - 埋め込みタグの案内帯・「稼働中のポップがありません」の注意書きは撤去
    (タグの設置はサイドバーから辿れる・稼働の有無は配信トグル自体が示す、という原則による)

  🔴 `/popup?id=...`(キャンペーン詳細)への行リンクもソフト遷移にした。
    `/popup` は編集中の入力を `sessionStorage` に保存して戻ってきたら復元する作りに変えた
    (`_lib/popupEditSession.ts`)ため、出入りをフルリロードの境界にする必要が無くなった
    (`GuardedLink.tsx` 参照)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { deleteJson, getJson, postJson } from "../../_lib/api";
import { ApiPopup, ApiSite, POPUP_LIMIT } from "../../_lib/types";
import { ApiPopupStatsMap, deleteConfirmStatsText, nextStatsState } from "../../_lib/stats";
import { Loading } from "../../_components/Loading";
import { ErrorBanner } from "../../_components/ErrorBanner";
import { EmptyState, PopupIcon } from "../../_components/EmptyState";
import { GuardedLink } from "../../_components/GuardedLink";
import { DeliveryToggle } from "../../_components/DeliveryToggle";
import { IconButton, TrashIcon } from "../../_components/IconButton";
import { AddPopupModal } from "../../_components/AddPopupModal";
import { ConfirmDeleteDialog } from "../../_components/ConfirmDeleteDialog";
import { useSessionState } from "../../_lib/sessionContext";
import { nextLoadErrorState } from "../../_lib/pageLoad";
import { createLatestWinsGuard, fetchLatestWins } from "../../_lib/latestWins";
import { actionsForToggle, applyDeleteResult, applyDeliveryActionResult } from "../../_lib/popupActions";

function PopupsContent() {
  const sessionState = useSessionState();
  const router = useRouter();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [popups, setPopups] = useState<ApiPopup[] | null>(null);
  const [stats, setStats] = useState<ApiPopupStatsMap | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiPopup | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /*
    🔴 行クリックとトグル/削除の二重発火を避ける: トグル・削除ボタンの `onClick` は
    `event.stopPropagation()` で行(`<tr>`/モバイルカード)への伝播を止める。
    モバイルは絶対配置の `<a>`(z-0)の上に操作ボタン(z-10・`pointer-events-auto`)を重ねる
    CSS だけの構成(デスクトップの `<tr>` は構造上同じ手が使えないため、JS の
    `onClick`/`onKeyDown` + `stopPropagation` で同じ結果にする)。
  */
  const [actionBusy, setActionBusy] = useState(false);
  const actionInFlightRef = useRef(false);

  const loadGuardRef = useRef(createLatestWinsGuard());
  const load = useCallback(async () => {
    if (siteId === "") return;
    await fetchLatestWins(
      loadGuardRef.current,
      async () => {
        const [siteResult, popupsResult, statsResult] = await Promise.all([
          getJson<ApiSite>(`/sites/${siteId}`),
          getJson<ApiPopup[]>(`/sites/${siteId}/popups`),
          getJson<ApiPopupStatsMap>(`/sites/${siteId}/popups/stats`),
        ]);
        return { siteResult, popupsResult, statsResult };
      },
      () => {}, // 再取得中も今の表示をそのまま残す(読み込み中に空にしない)
      ({ siteResult, popupsResult, statsResult }) => {
        if (!siteResult.ok || !popupsResult.ok) {
          const next = nextLoadErrorState(false, loadedOnceRef.current);
          setLoadError(next.loadError);
          setReloadError(next.reloadError);
          setStats(nextStatsState(siteResult.ok, popupsResult.ok, statsResult));
          return;
        }
        setLoadError(false);
        setReloadError(false);
        loadedOnceRef.current = true;
        setSite(siteResult.data);
        setPopups(popupsResult.data);
        setStats(nextStatsState(siteResult.ok, popupsResult.ok, statsResult));
      },
    );
  }, [siteId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  async function handleCreatePopup(name: string): Promise<string | null> {
    const result = await postJson<{ id: string }>(`/sites/${siteId}/popups`, { name });
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return `キャンペーンは${POPUP_LIMIT}件までです`;
      return "作成できませんでした。もう一度お試しください。";
    }
    setShowAddPopup(false);
    await load();
    return null;
  }

  /*
    🔴 `GET /sites/:id/popups` はアーカイブ済みも含めて返す
    (`listPopups` は archived_at で絞っていない)ため、アーカイブ済みのキャンペーンも普通の行として
    描かれる。そのトグルを ON にすると `activatePopup` の `archived_at is null` 条件に必ず当たらず、
    何度押しても「操作できませんでした」としか言えない死んだボタンになっていた。
    最終判断: **アーカイブ済みは「停止」の行として普通に表示し、トグルを ON にしたら
    restore → activate の順で呼ぶ**(画面にアーカイブという概念は出さない)。
    restore が失敗したら中断(アーカイブされたまま=表示どおり)。restore が成功した後に
    activate が失敗したら、**アーカイブへは戻さない**(この時点でサーバー上は既に
    「アーカイブされていない・停止中」の、他の停止中キャンペーンと見分けがつかない状態。
    `load()` で必ずサーバーの実値に合わせ直すので、表示と実データはずれない)。
  */
  async function runAction(popup: ApiPopup, action: "pause" | "activate") {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionBusy(true);
    setActionError(null);

    // アーカイブ済みを ON にしたときだけ ["restore", "activate"] になる(actionsForToggle 参照)。
    for (const step of actionsForToggle(popup, action)) {
      const result = await postJson<null>(`/popups/${popup.id}/${step}`, {});
      if (!result.ok) {
        actionInFlightRef.current = false;
        setActionBusy(false);
        if (result.reason === "no_deliverable_variant") {
          setActionError("配信できるパターンがありません。テキストか、画像を設定した画像のパターンを1つ保存してから稼働にしてください。");
        } else {
          setActionError("操作できませんでした。もう一度お試しください。");
        }
        // 🔴 restore だけ成功して activate が失敗した場合もここに来る。サーバー上の状態
        //   (アーカイブは外れたが停止中のまま)に表示を合わせ直す(表示と実データをずれさせない)。
        await load();
        return;
      }
    }
    setPopups((prev) => applyDeliveryActionResult(prev, popup.id, action));
    await load();
    actionInFlightRef.current = false;
    setActionBusy(false);
  }

  async function handleDelete() {
    if (deleteTarget === null || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionBusy(true);
    const result = await deleteJson<unknown>(`/popups/${deleteTarget.id}`, { confirm: "delete" });
    const deletedId = deleteTarget.id;
    setDeleteTarget(null);
    if (!result.ok) {
      actionInFlightRef.current = false;
      setActionBusy(false);
      setActionError("削除できませんでした。もう一度お試しください。");
      return;
    }
    setPopups((prev) => applyDeleteResult(prev, deletedId));
    await load();
    actionInFlightRef.current = false;
    setActionBusy(false);
  }

  return (
    // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` が1回だけ描く。ここはその中身(children)だけ。
    <>
      {siteId === "" ? (
        <ErrorBanner message="サイトが指定されていません。" />
      ) : sessionState !== "ready" ? (
        <Loading label="確認中" />
      ) : (
        <>
          {loadError && (
            <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />
          )}
          {reloadError && (
            <div className="mb-6">
              <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
            </div>
          )}
          {site === null && popups === null && !loadError && <Loading label="キャンペーンを読み込み中" />}

          {actionError && (
            <div className="mb-6">
              <ErrorBanner message={actionError} />
            </div>
          )}

          {popups !== null && (
            <>
            <div className="mb-3 flex items-end justify-between">
              <h1 className="text-xl font-semibold tracking-tight">キャンペーン</h1>
              <div className="flex items-center gap-4">
                <span className="font-mono text-xs text-ink/60">{popups.length} / {POPUP_LIMIT}</span>
                {popups.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAddPopup(true)}
                    className="h-9 rounded-lg bg-ink px-3.5 text-sm font-semibold text-paper hover:bg-ink/90
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    + 追加
                  </button>
                )}
              </div>
            </div>

            {popups.length === 0 ? (
              <EmptyState
                icon={PopupIcon}
                title="まだキャンペーンがありません"
                description="埋め込みタグをLPに貼ったら、キャンペーンを作って配信を始めましょう。"
                action={
                  <button
                    type="button"
                    onClick={() => setShowAddPopup(true)}
                    className="h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    + 追加
                  </button>
                }
              />
            ) : (
              <>
                {/* 390px: カード型。行全体(絶対配置の <a> 相当)を z-0、操作だけ z-10 + pointer-events-auto */}
                <div className="flex flex-col gap-3 lg:hidden">
                  {popups.map((popup) => (
                    <div
                      key={popup.id}
                      /*
                        🔴 `pointer-events-none` が無いと、名前のテキストや
                        トグル・削除の間の余白をタップしても何も起きない(トグル/削除の `<span>` が
                        `pointer-events-auto` で個別に取り戻している前提は、親がまず `none` に
                        なっていないと成り立たない)。カード全体を `pointer-events-none` にして、
                        既定で下の `<a>`(行全体のリンク)にクリックを通す。
                      */
                      className="group relative rounded-xl border border-line bg-surface p-4 pointer-events-none hover:bg-paper focus-within:bg-paper"
                    >
                      <GuardedLink
                        href={`/popup?id=${popup.id}`}
                        aria-label={`${popup.name} の詳細を開く`}
                        /*
                          🔴 `pointer-events: none` は inherit されるため、
                          親(カード全体)に `pointer-events-none` を付けただけでは、この `<a>` 自身も
                          継承で none になり、クリックがさらに外側(一覧コンテナ)まで素通りしてしまう
                          (`document.elementFromPoint` で実測して確認)。`<a>` にも明示的に
                          `pointer-events-auto` を付けて取り戻す。
                        */
                        className="pointer-events-auto absolute inset-0 z-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                      >
                        {null}
                      </GuardedLink>
                      <div className="relative z-10 flex items-center justify-between">
                        <span className="pointer-events-auto" onClick={(e) => e.stopPropagation()}>
                          <DeliveryToggle
                            active={popup.status === "active"}
                            disabled={actionBusy}
                            label={`${popup.name}の配信`}
                            onToggle={() => runAction(popup, popup.status === "active" ? "pause" : "activate")}
                          />
                        </span>
                        <span className="pointer-events-auto" onClick={(e) => e.stopPropagation()}>
                          <IconButton
                            as="button"
                            label="完全に削除"
                            tone="danger"
                            icon={<TrashIcon />}
                            disabled={actionBusy}
                            onClick={() => setDeleteTarget(popup)}
                          />
                        </span>
                      </div>
                      <div className="relative z-10 mt-3 text-sm font-medium text-ink">{popup.name}</div>
                    </div>
                  ))}
                </div>

                {/*
                  1280px: 表。
                  🔴 `<tr>` に `tabIndex`+`onKeyDown` を置くと、
                  トグル(Space)・削除(Enter)にフォーカスした状態でキーを押したとき、そのキー入力が
                  `<tr>` まで伝播(keydownはbubbleする。click用のstopPropagationは止められない)し、
                  詳細へ誤って遷移してしまう。加えて `<tr>` はネイティブにlink/buttonのロールを持たず、
                  支援技術にリンクとして伝わらない。
                  → **キャンペーン名を本物の `<a>`(詳細へのリンク)にし、キー操作はそちらに任せる**。
                  `<tr>` の `onClick` はマウスでの「行のどこを押しても開く」ための便宜として残すが、
                  `tabIndex`/`onKeyDown`/`aria-label` は外す(キーボード操作の入口は `<a>` だけにする)。
                */}
                <div className="hidden overflow-hidden rounded-xl border border-line bg-surface lg:block">
                  <table className="w-full table-fixed border-collapse">
                    <colgroup>
                      <col className="w-[132px]" />
                      <col />
                      <col className="w-[80px]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-line text-xs font-medium text-ink/60">
                        <th scope="col" className="px-5 py-3 text-left font-medium">配信</th>
                        <th scope="col" className="px-3 py-3 text-left font-medium">キャンペーン</th>
                        <th scope="col" className="px-5 py-3 text-right font-medium">
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {popups.map((popup) => (
                        <tr
                          key={popup.id}
                          onClick={() => {
                            router.push(`/popup?id=${popup.id}`);
                          }}
                          className="cursor-pointer hover:bg-paper"
                        >
                          <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                            <DeliveryToggle
                              active={popup.status === "active"}
                              disabled={actionBusy}
                              label={`${popup.name}の配信`}
                              onToggle={() => runAction(popup, popup.status === "active" ? "pause" : "activate")}
                            />
                          </td>
                          <td className="px-3 py-3.5 text-sm font-medium text-ink">
                            <GuardedLink
                              href={`/popup?id=${popup.id}`}
                              className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                            >
                              {popup.name}
                            </GuardedLink>
                          </td>
                          <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end">
                              <IconButton
                                as="button"
                                label="完全に削除"
                                tone="danger"
                                icon={<TrashIcon />}
                                disabled={actionBusy}
                                onClick={() => setDeleteTarget(popup)}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
          </>
        )}

      {showAddPopup && <AddPopupModal onCancel={() => setShowAddPopup(false)} onCreate={handleCreatePopup} />}
      {deleteTarget && (
        <ConfirmDeleteDialog
          name={deleteTarget.name}
          stats={deleteConfirmStatsText(stats, deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </>
  );
}

export default function PopupsPage() {
  return (
    <Suspense fallback={null}>
      <PopupsContent />
    </Suspense>
  );
}
