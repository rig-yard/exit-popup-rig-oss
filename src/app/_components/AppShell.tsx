"use client";

/*
  全体構成: 左サイドバー + パンくず + 390pxのハンバーガー/ドロワー。
  デザイン一覧・キャンペーンの詳細・表示設定・タグの設置はこの中の `children` としてそのまま載せ替える。

  🔴 WORKSPACE(訂正済みの用語): サイトとは別の、owner 1人に1つの名前。デスクトップの常設サイドバーと
    390pxのドロワーの両方に同じ `SidebarContent` を描くため、**ここで1回だけ** `GET /workspace` を
    取得して両方へ渡す(各 `SidebarContent` が個別に取得すると二重に読みに行く)。

  🔴 静的書き出しはページごとに別のHTML(= ページを移るたびにこの
    コンポーネントが丸ごと再マウントされる)なので、ページを移るたびに `GET /workspace` を
    取り直す間、WORKSPACE名が一瞬「読み込み中…」になっていた。`workspaceCache.ts`(sessionStorage。
    タブの中だけで覚える)に最後に取得した名前があれば、初回描画からそれを出し、裏で取り直した
    値に揃える。初回アクセスでキャッシュが無いときだけ、未取得の状態(`workspace===null`)の
    まま——その表示は Sidebar.tsx 側で「読み込み中…」の文字を出さず空白にする(無い情報を
    「読み込み中」と言い切らない。すぐ裏で取り直すので文字が入れ替わるよりの方が自然)。

  🔴 枠・製品名・メニューのリンクは `/session` の確認前から
    描いてよい(リンク先の各ページが自分で確認し直す)が、**`GET /workspace` の取得・
    WORKSPACE名の編集・ログアウトは `/session` が確認済みになるまで呼ばない・押せない**
    (未確認の間にこれらのAPIを叩く理由が無い)。呼び出し側(各ページ)が `useRequireSession()`
    の結果を `sessionReady` として渡す。タブ内キャッシュの名前(上記)は確認前でも出してよい
    (本人の表示でありちらつき対策が目的のため)。
*/
import { useEffect, useRef, useState } from "react";
import { getJson } from "../_lib/api";
import { createLatestWinsGuard } from "../_lib/latestWins";
import type { ApiWorkspace } from "../_lib/types";
import { readCachedWorkspaceName, writeCachedWorkspaceName } from "../_lib/workspaceCache";
import { Breadcrumb } from "./Breadcrumb";
import { Drawer } from "./Drawer";
import { BRAND, SidebarContent, type NavKey } from "./Sidebar";
import type { LeaveGuard } from "../_lib/unsavedChanges";

export function AppShell({
  activeNav,
  siteId,
  breadcrumbItems,
  onBeforeLeave,
  sessionReady,
  children,
}: {
  activeNav: NavKey;
  siteId: string;
  breadcrumbItems: Array<{ label: string; href?: string }>;
  onBeforeLeave?: LeaveGuard;
  /** `useRequireSession()` が `"ready"` になったかどうか(呼び出し側のページが渡す)。 */
  sessionReady: boolean;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 🔴 初期値はキャッシュ(前のページで取得済みの名前)。無ければ null のまま
  //   (= 未取得。Sidebar.tsx はこれを「読み込み中…」ではなく空白で表す)。
  const [workspace, setWorkspace] = useState<ApiWorkspace | null>(() => {
    const cached = readCachedWorkspaceName();
    return cached !== null ? { name: cached } : null;
  });
  const [workspaceLoadError, setWorkspaceLoadError] = useState(false);
  /*
   * 🔴 ページ到着直後に発行した `GET /workspace` がまだ応答していない間に
   *   リネーム(保存)すると、後から届くその古いGETの応答が、保存した新しい名前を
   *   旧名で上書きしてしまっていた(実機で再現: キャッシュから即表示→その間に保存→
   *   1.5秒後に古いGETが解決→旧名に戻る)。`latestWins.ts` の世代ガードと同じ考え方で、
   *   「リネーム(保存)」も GET と同じ1つの世代列に乗せる——保存するたびに世代を進め、
   *   その後に届くGETの応答は「最新の世代」と比べて古ければ捨てる。
   */
  const workspaceGuardRef = useRef(createLatestWinsGuard());

  useEffect(() => {
    // 🔴 `/session` が確認済みになるまで `GET /workspace` を呼ばない。
    if (!sessionReady) return;
    let active = true;
    const requestId = workspaceGuardRef.current.next();
    getJson<ApiWorkspace>("/workspace").then((result) => {
      if (!active) return;
      // 🔴 この取得より後に保存(リネーム)が確定していたら、古い応答として捨てる。
      if (!workspaceGuardRef.current.isLatest(requestId)) return;
      if (result.ok) {
        setWorkspace(result.data);
        setWorkspaceLoadError(false);
        writeCachedWorkspaceName(result.data.name);
      } else {
        // 🔴 キャッシュから出した名前が既に画面にあっても、それは消さない(失敗を「不明」に戻さない)。
        //   Sidebar.tsx は `loadError` を優先して出すので、「取得できませんでした」は
        //   キャッシュが無かった=初回アクセス時の失敗でしか見えない。
        setWorkspaceLoadError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [sessionReady]);

  function handleWorkspaceRenamed(name: string) {
    // 🔴 以降に届く(保存より前に発行された)GETの応答を「古い」扱いにする。
    workspaceGuardRef.current.next();
    setWorkspace({ name });
    writeCachedWorkspaceName(name);
  }

  return (
    <div className="min-h-screen sm:flex">
      {/* デスクトップ: 常設のサイドバー */}
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface p-5 sm:flex sm:flex-col" aria-label="サイドバー">
        <SidebarContent
          activeNav={activeNav}
          siteId={siteId}
          workspace={workspace}
          workspaceLoadError={workspaceLoadError}
          onWorkspaceRenamed={handleWorkspaceRenamed}
          onBeforeLeave={onBeforeLeave}
          sessionReady={sessionReady}
        />
      </aside>

      {/* 390px: ハンバーガー + ドロワー */}
      <div className="flex h-14 items-center justify-between border-b border-line bg-surface px-4 sm:hidden">
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-sm font-semibold tracking-tight">{BRAND}</span>
        </div>
        <button
          type="button"
          aria-label="メニューを開く"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-ink/70 hover:bg-paper
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {drawerOpen && (
        <Drawer titleId="adpop-drawer-title" onClose={() => setDrawerOpen(false)}>
          <div className="mb-4 flex items-center justify-between">
            <span id="adpop-drawer-title" className="text-sm font-semibold tracking-tight">
              {BRAND}
            </span>
            <button
              type="button"
              aria-label="メニューを閉じる"
              onClick={() => setDrawerOpen(false)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-ink/70 hover:bg-paper
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <SidebarContent
            activeNav={activeNav}
            siteId={siteId}
            workspace={workspace}
            workspaceLoadError={workspaceLoadError}
            onWorkspaceRenamed={handleWorkspaceRenamed}
            onBeforeLeave={onBeforeLeave}
            sessionReady={sessionReady}
            onNavigate={() => setDrawerOpen(false)}
          />
        </Drawer>
      )}

      <main className="min-w-0 flex-1 px-5 py-8 sm:px-10 sm:py-10">
        <Breadcrumb items={breadcrumbItems} onBeforeLeave={onBeforeLeave} />
        {children}
      </main>
    </div>
  );
}
