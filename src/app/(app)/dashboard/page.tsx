"use client";

/*
  ダッシュボード。単位は「選んだサイト」(サイト切り替えはサイドバーの上部)。

  🔴 設計判断1: 「+ ポップを作成」はこの画面から削除した(ポップの作成は「ポップ管理」の画面からだけ行う)。
  🔴 設計判断2: 推移グラフのクリック数は右側の第2軸(`DailyChart` 参照)。
  🔴 タイルの数字・推移グラフは選んだ期間(7/30/90日)に連動する。両方とも同じ
    `GET /sites/:siteId/stats/daily?period=N` を1回読むだけで出す(タイルの合計はその場で合算する。
    この新規APIがこの変更で作るもの)。
  🔴 コンバージョン数タイルは撤去した(CVタグ未実装の「— 準備中」は
    「基本的に無駄なものは表示しない」という原則に照らして外す)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getJson } from "../../_lib/api";
import type { ApiSite } from "../../_lib/types";
import {
  DAILY_STATS_PERIODS,
  formatClickThroughRate,
  isDailyStatsPeriod,
  sumDailyStats,
  type DailyStatsPeriod,
  type DailyStatsPoint,
} from "../../_lib/stats";
import { Loading } from "../../_components/Loading";
import { ErrorBanner } from "../../_components/ErrorBanner";
import { DailyChart } from "../../_components/DailyChart";
import { useSessionState } from "../../_lib/sessionContext";
import { nextLoadErrorState } from "../../_lib/pageLoad";
import { createLatestWinsGuard, fetchLatestWins } from "../../_lib/latestWins";

const PERIOD_LABEL: Record<DailyStatsPeriod, string> = { 7: "過去7日間", 30: "過去30日間", 90: "過去90日間" };

function Tile({ label, value, caption, icon }: { label: string; value: string; caption: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-ink/70">{label}</span>
        <span className="text-ink/40" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="font-mono text-2xl font-semibold text-ink">{value}</div>
      <div className="mt-1 text-xs text-ink/60">{caption}</div>
    </div>
  );
}

function DashboardContent() {
  const sessionState = useSessionState();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const [period, setPeriod] = useState<DailyStatsPeriod>(30);
  const [daily, setDaily] = useState<DailyStatsPoint[] | null>(null);
  const [dailyError, setDailyError] = useState(false);
  const loadedOnceRef = useRef(false);

  const loadSite = useCallback(async () => {
    if (siteId === "") return;
    const result = await getJson<ApiSite>(`/sites/${siteId}`);
    const next = nextLoadErrorState(result.ok, loadedOnceRef.current);
    setLoadError(next.loadError);
    setReloadError(next.reloadError);
    if (result.ok) {
      loadedOnceRef.current = true;
      setSite(result.data);
    }
  }, [siteId]);

  /*
    🔴 期間を素早く切り替えると、後から出したリクエストより前のリクエストの応答が
    遅れて返ることがある(90日→7日と素早く切り替え、90日の応答が後着する等)。
    `fetchLatestWins`(`_lib/latestWins.ts`)で、**最後に発行したリクエストの応答だけ**を
    state に反映する(古い応答は無視する。ロジック自体はDOM抜きでテスト済み=latestWins.test.ts)。
    また、再取得の間は前の期間の数字を「最新」のまま出し続けない(`daily` を即座に null にし、
    読み込み中の表示に倒す。タイルは「—」・グラフはLoadingになる)。
  */
  const dailyGuardRef = useRef(createLatestWinsGuard());
  const loadDaily = useCallback(async () => {
    if (siteId === "") return;
    await fetchLatestWins(
      dailyGuardRef.current,
      () => getJson<DailyStatsPoint[]>(`/sites/${siteId}/stats/daily?period=${period}`),
      () => {
        setDaily(null);
        setDailyError(false);
      },
      (result) => {
        setDailyError(!result.ok);
        setDaily(result.ok ? result.data : null);
      },
    );
  }, [siteId, period]);

  useEffect(() => {
    if (sessionState !== "ready") return;
    void loadSite();
    void loadDaily();
  }, [sessionState, loadSite, loadDaily]);

  function handlePeriodChange(value: string) {
    const n = Number(value);
    if (isDailyStatsPeriod(n)) setPeriod(n);
  }

  const totals = daily !== null ? sumDailyStats(daily) : null;

  return (
    // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` が1回だけ描く(appShellRoute.ts参照)。
    //   ここはその中身(children)だけ。セッション確認・サイト取得の「読み込み中」はここに留める
    //   (全体を `return null` すると、ページを移るたびにレイアウトの中身がちらつく)。
    <>
      {siteId === "" ? (
        <ErrorBanner message="サイトが指定されていません。" />
      ) : sessionState !== "ready" ? (
        <Loading label="確認中" />
      ) : (
        <>
          {loadError && <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={loadSite} retryLabel="再読み込み" />}
          {reloadError && (
            <div className="mb-6">
              <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={loadSite} retryLabel="再読み込み" />
            </div>
          )}
          {site === null && !loadError && <Loading label="サイトを読み込み中" />}

          {site !== null && (
            <>
              <h1 className="mb-6 text-xl font-semibold tracking-tight">ダッシュボード</h1>

            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-ink/70">
                パフォーマンス <span className="font-normal text-ink/60">・UTC</span>
              </h2>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <select
                    aria-label="集計期間"
                    value={period}
                    onChange={(e) => handlePeriodChange(e.target.value)}
                    className="h-11 appearance-none rounded-lg border border-line bg-surface pl-3 pr-8 text-sm font-medium text-ink
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    {DAILY_STATS_PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {PERIOD_LABEL[p]}
                      </option>
                    ))}
                  </select>
                  <svg className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink/60" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <button
                  type="button"
                  aria-label="再読み込み"
                  onClick={loadDaily}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-line text-ink/60 hover:bg-paper
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M4 10a6 6 0 0110.9-3.5M16 10a6 6 0 01-10.9 3.5M14 4v3h-3M6 16v-3h3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {dailyError && (
              <div className="mb-4">
                <ErrorBanner message="数値を取得できませんでした" onRetry={loadDaily} retryLabel="再読み込み" />
              </div>
            )}

            <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <Tile
                label="表示数"
                value={totals !== null ? totals.impression.toLocaleString("ja-JP") : "—"}
                caption="配信されたポップの回数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" stroke="currentColor" strokeWidth="1.4" />
                    <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                }
              />
              <Tile
                label="クリック数"
                value={totals !== null ? totals.click.toLocaleString("ja-JP") : "—"}
                caption="ボタンをクリックした回数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M7 3l9 6-4 1-1 4-4-11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                }
              />
              <Tile
                label="クリック率"
                value={totals !== null ? formatClickThroughRate(totals.impression, totals.click) : "—"}
                caption="クリック数 ÷ 表示数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M3 15l4-5 3 3 6-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
              />
            </div>

            <div className="rounded-xl border border-line bg-surface p-5">
              <h2 className="text-sm font-semibold text-ink">表示数とクリック数の推移</h2>
              <p className="mb-4 text-xs text-ink/60">日別の内訳です。</p>
              {daily === null && !dailyError && <Loading label="数値を読み込み中" />}
              {daily !== null && <DailyChart points={daily} />}
            </div>
            </>
          )}
        </>
      )}
    </>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}
