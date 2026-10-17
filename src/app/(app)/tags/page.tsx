"use client";

/*
  タグの設置(旧 `/site?id=` が持っていた埋め込みタグ・許可ドメインをここへ集約)。
  🔴 画面を整理した: 「タグの設置」の二重表示(パンくず+見出し)・</body>の説明文・
    右上の「サイト名・許可ドメインを編集」・許可ドメインの説明文・CV計測タグのカード(準備中)を
    置かない(原則「基本的に無駄なものは表示しない」)。サイト名の編集はWORKSPACE名があれば
    足りるため出さない。
  🔴 許可ドメインの削除が「+ ドメインを追加」から開くモーダルの中にしか
    無く、見つけにくかった。各ドメインのチップに直接 ✕ を付けた。
    「+ ドメインを追加」は追加専用のインライン入力に変え、名前の編集・モーダルは撤去した(このページから専用の
    `EditSiteModal` を使う理由が無くなったため、`AddSiteModal.tsx` 自体を削除した)。
  🔴 チップの ✕ は直接押せる場所にあって誤って押しやすいので、確認を挟む:
    `ConfirmRemoveOriginDialog`(既存の `Modal` を使う)で一度確認する——「このドメインでは
    ポップが表示されなくなります」だけを伝える(統計が消える完全削除〈`ConfirmDeleteDialog`〉と
    は文言・重さを分ける。カウントダウンは無い=すぐ元に戻せる操作のため)。キャンセル後は
    ✕ 自体にフォーカスが戻る(Modal の既定の復帰先)。削除成功後は追加用の入力欄にフォーカスを
    明示的に戻す(`handleRemoveOrigin` 参照。✕ 自体がDOMから消えるため)。
  🔴 「埋め込みタグ」見出し横の `InfoTooltip` に、撤去した説明文の要点(貼り付け先)だけ残した。

  🔴 1インストール=1サイト。サイトが0件のとき(新しく立てた直後)は、この画面が
    初回の設定を兼ねる——許可ドメインを入れるとサイトができる(サイト名は自動=最初のドメインの
    ホスト名。画面には出さない。「1つしかない物の選択・名前は出さない」という原則による)。

  🔴 許可ドメインの事前チェックが、`new URL()` を使った
    自前の簡易判定になっていて、サーバー側の正規表現(`ORIGIN_PATTERN`)とずれうる形があった
    (実測: 末尾にドットが付いた形=`https://example.com.` を通してしまっていた。`url.origin`が
    入力をそのまま返すため `url.origin === value` が真になる。サーバーはホスト名の各ラベルが
    英数字で終わることを要求する正規表現で、この形を拒む)。**サーバーが実際に判定に使う関数
    (`isOrigin`、`src/lib/data/shapes.ts`)をそのままimportする**(`shapes.ts`自身のコメントに
    「Node固有のimportを足さない(Workers で動く)」とあり、実際に `npm run build` でこのページの
    クライアントバンドルに問題なく含まれることも確認した)。事前チェックはあくまで利便性のためで、
    最終的な正しさはサーバー側のPUTが見る(ここが緩くても安全性は変わらない)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getJson, postJson, putJson } from "../../_lib/api";
import type { ApiSite } from "../../_lib/types";
import { Loading } from "../../_components/Loading";
import { ErrorBanner, FieldError } from "../../_components/ErrorBanner";
import { CopyButton } from "../../_components/CopyButton";
import { InfoTooltip } from "../../_components/InfoTooltip";
import { ConfirmRemoveOriginDialog } from "../../_components/ConfirmRemoveOriginDialog";
import { useSessionState } from "../../_lib/sessionContext";
import { TAP_TARGET_44_ICON } from "../../_lib/a11y";
import { DELIVERY_ORIGIN } from "../../_lib/delivery";
import { embedTag } from "../../_lib/embedTag";
import { nextLoadErrorState } from "../../_lib/pageLoad";
import { saveOrigins as saveOriginsPure } from "../../_lib/originsSave";
import { isOrigin } from "../../../lib/data/shapes";

/** サーバー側(`src/admin/body.ts`)と同じ上限。許可ドメインは20件まで。 */
const MAX_ORIGINS = 20;

/**
 * サイトが0件のときの初回の設定。許可ドメインの入力+「追加」だけ
 * (サイト名は入力させない。最初のドメインのホスト名を自動で入れる)。
 */
function InitialSetup({ onCreated }: { onCreated: (siteId: string) => void }) {
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    const value = origin.trim();
    if (!isOrigin(value)) {
      setError("https:// から始まる、パスの無いURLを入力してください(例: https://example.com)");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const name = new URL(value).hostname;
    const result = await postJson<{ id: string }>("/sites", { name, allowedOrigins: [value] });
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") {
        setError("すでにサイトが作成済みです。画面を再読み込みしてください。");
      } else if (result.status === 400) {
        setError("入力内容を確認してください。");
      } else {
        setError("作成できませんでした。もう一度お試しください。");
      }
      return;
    }
    onCreated(result.data.id);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-2">
          <span className="inline-block h-6 w-6 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-base font-semibold tracking-tight">EXIT POPUP - RIG</span>
        </div>
        <form className="rounded-xl border border-line bg-surface p-7" onSubmit={handleSubmit}>
          <h1 className="mb-5 text-lg font-semibold tracking-tight">タグの設置</h1>
          {error && <FieldError id="initial-setup-error" message={error} />}
          <div className="mb-6">
            <label htmlFor="initial-origin" className="mb-1.5 block text-sm font-medium text-ink">
              許可ドメイン
            </label>
            <input
              id="initial-origin"
              type="text"
              placeholder="https://example.com"
              value={origin}
              disabled={submitting}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-11 font-mono text-sm text-ink placeholder:text-ink/30
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-lg bg-ink text-sm font-semibold text-paper
                       hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/60
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {submitting ? "追加中…" : "追加"}
          </button>
        </form>
      </div>
    </main>
  );
}

function TagsContent() {
  const sessionState = useSessionState();
  const router = useRouter();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);
  // 🔴 許可ドメインの追加・削除は、どちらも同じリソース(site.allowedOrigins)への即時PUT
  //   なので、片方の処理中はもう片方も止める(競合更新を避ける。ポップ一覧の actionBusy と同じ考え方)。
  const [originDraft, setOriginDraft] = useState("");
  const [originBusy, setOriginBusy] = useState(false);
  const [originError, setOriginError] = useState<string | null>(null);
  // 🔴 削除する前に確認する。✕ を押した時点ではまだ削除しない。
  const [confirmRemoveOrigin, setConfirmRemoveOrigin] = useState<string | null>(null);
  // 🔴 チップの✕はクリックした本人が消えるので、
  //   削除後にフォーカスが <body> に落ちる(キーボード操作者が迷子になる)。削除成功後は
  //   追加用の入力欄へフォーカスを明示的に戻す(次にやりそうな操作の近くに置く)。
  const originDraftInputRef = useRef<HTMLInputElement>(null);
  // 🔴 URLに ?site= が無いとき、既にサイトがあるか(=旧い直リンク)を一度だけ確かめる(初期値は
  //   siteId の有無から直接決める。effect 内では「0件と分かった」ときだけ setState する——
  //   setState をeffect本体で同期的に呼ぶと連鎖レンダーの原因になるため、非同期コールバックの
  //   中だけで呼ぶ=react-hooks/set-state-in-effect の規則に沿う)。
  const [checkingSites, setCheckingSites] = useState(siteId === "");

  useEffect(() => {
    if (siteId !== "" || sessionState !== "ready") return;
    let active = true;
    getJson<ApiSite[]>("/sites").then((result) => {
      if (!active) return;
      if (result.ok && result.data.length > 0) {
        router.replace(`/tags?site=${result.data[0].id}`);
        return;
      }
      setCheckingSites(false);
    });
    return () => {
      active = false;
    };
  }, [siteId, sessionState, router]);

  /*
    🔴 戻り値(ok/data)を持たせたのは `saveOrigins`(`_lib/originsSave.ts`)に「表示の念押し」の
    再取得として渡すため。既存の呼び出し側
    (`useEffect`・`onRetry={load}`)は戻り値を使わないので影響しない。
  */
  const load = useCallback(async (): Promise<{ ok: boolean; data?: ApiSite }> => {
    if (siteId === "") return { ok: false };
    const result = await getJson<ApiSite>(`/sites/${siteId}`);
    const next = nextLoadErrorState(result.ok, loadedOnceRef.current);
    setLoadError(next.loadError);
    setReloadError(next.reloadError);
    if (result.ok) {
      loadedOnceRef.current = true;
      setSite(result.data);
      return { ok: true, data: result.data };
    }
    return { ok: false };
  }, [siteId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  /**
   * 許可ドメインだけを入れ替えて保存する(名前は今の値をそのまま送り返す)。
   * 🔴 以前は `setOriginBusy(false)` を `await load()` より
   *   前に呼んでいて、保存は終わっていても再取得がまだの間、排他(追加・削除の両ボタンの
   *   `disabled`)が外れてしまっていた。再取得が終わるまで `originBusy` を保ち続ける。
   * 🔴 それでも、PUTが成功した直後の再取得(`load()`)
   *   自体が失敗すると(`load()` は失敗時 `site` を書き換えない=`nextLoadErrorState` 参照)、
   *   `site.allowedOrigins` が古いまま・`originBusy` だけ解除されていた——次の追加・削除が
   *   その古い配列を元に計算し、直前の成功を上書きしてしまう。PUTの成否だけを正とし、
   *   再取得は表示の念押しに格下げる(この判定自体は `saveOriginsPure`=`_lib/originsSave.ts`
   *   という、DOM・React無しでテスト済みの純粋関数に切り出した。`originsSave.test.ts` に
   *   「PUT成功・直後の再取得失敗」のシーケンスの再現検査がある)。ここ(コンポーネント側)は
   *   実際の `PUT`/`load()` を注入して呼ぶだけ。
   */
  async function saveOrigins(nextOrigins: string[]): Promise<boolean> {
    if (site === null || originBusy) return false;
    setOriginBusy(true);
    const result = await saveOriginsPure(nextOrigins, {
      put: (origins) => putJson<null>(`/sites/${siteId}`, { name: site.name, allowedOrigins: origins }),
      reload: async () => {
        const loadResult = await load();
        return { ok: loadResult.ok, allowedOrigins: loadResult.data?.allowedOrigins };
      },
    });
    setOriginBusy(false);
    if (!result.ok) {
      setOriginError(result.error);
      return false;
    }
    setOriginError(null);
    setSite((prev) => (prev ? { ...prev, allowedOrigins: result.allowedOrigins } : prev));
    return true;
  }

  async function handleAddOrigin() {
    if (site === null) return;
    const value = originDraft.trim();
    if (value === "") return;
    if (!isOrigin(value)) {
      setOriginError("https:// から始まる、パスの無いURLを入力してください(例: https://example.com)");
      return;
    }
    if (site.allowedOrigins.includes(value)) {
      setOriginError("すでに追加されています");
      return;
    }
    if (site.allowedOrigins.length >= MAX_ORIGINS) {
      setOriginError(`許可ドメインは${MAX_ORIGINS}件までです`);
      return;
    }
    const saved = await saveOrigins([...site.allowedOrigins, value]);
    if (saved) setOriginDraft("");
  }

  async function handleRemoveOrigin(origin: string) {
    if (site === null) return;
    const saved = await saveOrigins(site.allowedOrigins.filter((o) => o !== origin));
    /*
      🔴 実機ブラウザ(Playwright・Chromium)で確認して直した: 押した✕自体がDOMから消えるため、
      フォーカスを追加用の入力欄へ戻す必要がある(ここまでは既存のコメントどおり)。だが
      `saveOrigins` 成功直後にこの場で即 `.focus()` を呼んでも効かなかった——`disabled`
      (`originBusy`)を false に戻す `setOriginBusy(false)` はこの関数の外(`saveOrigins` 内)で
      呼ばれていて、まだ React のコミット(実DOMの `disabled` 属性の更新)が済んでいない
      タイミングでは、入力欄はまだ `disabled` のままで `.focus()` が黙って無視される
      (disabled な要素はフォーカスできない)。`requestAnimationFrame` で次の描画後に回すと、
      その時点では確実にコミット済みなので効く。
    */
    if (saved) requestAnimationFrame(() => originDraftInputRef.current?.focus());
  }

  /*
    🔴 サイトが0件のときの専用フロー(新しく立てた直後だけの導線)。サイドバーから辿る通常の
    ナビゲーションには乗らないので、AppShellの外のまま(サイドバーを出す前提の作りではない。
    `(app)/layout.tsx` が `?site=` 無しの `/tags` ではAppShell自体を描かない=appShellRoute.ts参照)。
  */
  if (siteId === "") {
    if (sessionState !== "ready" || checkingSites) return <Loading label="確認中" />;
    return <InitialSetup onCreated={(id) => router.replace(`/tags?site=${id}`)} />;
  }

  return (
    // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` が1回だけ描く。ここはその中身(children)だけ。
    <>
      {sessionState !== "ready" ? (
        <Loading label="確認中" />
      ) : (
        <>
          {loadError && <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />}
          {reloadError && (
            <div className="mb-6">
              <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
            </div>
          )}
          {site === null && !loadError && <Loading label="サイトを読み込み中" />}

          {site !== null && (
            <>
              <h1 className="mb-6 text-xl font-semibold tracking-tight">タグの設置</h1>

                <div className="mb-6 rounded-xl border border-line bg-surface p-5">
                  <div className="mb-2 flex items-center gap-1.5">
                    <h2 className="text-sm font-semibold text-ink">埋め込みタグ</h2>
                    <InfoTooltip text="LP の </body> の直前に貼り付けてください" />
                  </div>
                  {(() => {
                    const tag = embedTag(DELIVERY_ORIGIN, site.siteKey);
                    if (tag === null) {
                      return (
                        <div className="rounded-lg border border-dashed border-line bg-paper px-3 py-2.5 text-xs text-ink/60">配信先が未設定です</div>
                      );
                    }
                    return (
                      <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5">
                        <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-ink/70">{tag}</code>
                        <CopyButton text={tag} label="埋め込みタグをコピー" />
                      </div>
                    );
                  })()}
                </div>

                <div className="rounded-xl border border-line bg-surface p-5">
                  <h2 className="mb-2 text-sm font-semibold text-ink">許可ドメイン</h2>
                  {originError && <FieldError id="origin-error" message={originError} />}
                  <div className={`flex flex-wrap gap-2 ${originError ? "mt-2" : ""}`}>
                    {site.allowedOrigins.length === 0 ? (
                      <span className="text-sm text-ink/60">未設定</span>
                    ) : (
                      site.allowedOrigins.map((origin) => (
                        <span
                          key={origin}
                          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-xs text-ink/70"
                        >
                          {origin}
                          <button
                            type="button"
                            aria-label={`${origin} を削除`}
                            disabled={originBusy}
                            onClick={() => setConfirmRemoveOrigin(origin)}
                            className={`text-ink/60 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44_ICON}`}
                          >
                            ✕
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <label htmlFor="origin-draft" className="sr-only">
                      許可ドメインを追加
                    </label>
                    <input
                      id="origin-draft"
                      ref={originDraftInputRef}
                      type="text"
                      placeholder="https://example.com"
                      value={originDraft}
                      disabled={originBusy}
                      onChange={(e) => {
                        setOriginDraft(e.target.value);
                        setOriginError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddOrigin();
                        }
                      }}
                      className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-xs text-ink placeholder:text-ink/30
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    />
                    <button
                      type="button"
                      disabled={originBusy}
                      onClick={() => void handleAddOrigin()}
                      className="h-9 shrink-0 rounded-lg border border-line px-3 text-xs font-semibold text-ink hover:bg-paper
                                 disabled:cursor-not-allowed disabled:opacity-60
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      + 追加
                    </button>
                  </div>
                </div>
            </>
          )}
        </>
      )}

      {confirmRemoveOrigin !== null && (
        <ConfirmRemoveOriginDialog
          origin={confirmRemoveOrigin}
          onCancel={() => setConfirmRemoveOrigin(null)}
          onConfirm={async () => {
            const origin = confirmRemoveOrigin;
            setConfirmRemoveOrigin(null);
            await handleRemoveOrigin(origin);
          }}
        />
      )}
    </>
  );
}

export default function TagsPage() {
  return (
    <Suspense fallback={null}>
      <TagsContent />
    </Suspense>
  );
}
