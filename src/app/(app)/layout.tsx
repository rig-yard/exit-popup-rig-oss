"use client";

/*
  ログイン後の画面(ダッシュボード・デザイン・キャンペーンの中・表示設定・タグの設置)の共通の枠。

  🔴 ページを移るたびにサイドバーがチカチカしていた: 以前は各 `page.tsx` が
    自分で `<AppShell>` を描いていた。静的書き出し(`output: "export"`)はページごとに別のHTMLで、
    さらにリンクが `window.location.href` でページ全体を読み直していた(`GuardedLink.tsx` 参照、
    今回ソフト遷移に変えた)ため、ページを移るたびに画面の根から全部作り直り、サイドバー・
    ログイン確認(`/session`)・WORKSPACE名の取得(`AppShell` が持つ)もやり直していた。

    このルートグループ `(app)` の共通 `layout.tsx` に `<AppShell>` を1回だけ置き、ページ
    (`children`)だけを差し替える——Next のクライアント側遷移は、同じ layout を持つルート間では
    その layout 自体を作り直さない(URLには出ない。ルートグループなので `/dashboard` 等のパスは
    変わらない)。`/session`・`GET /workspace` は `AppShell`/`useRequireSession` がここで1回
    呼ぶだけになり、各ページは結果を `useSessionState()` で読むだけにした。

  🔴 `activeNav`・パンくずは今居るURLだけから決まる(`_lib/appShellRoute.ts`)。例外は `/popup`
    (キャンペーン詳細)の siteId だけ——本体の取得が終わるまでURLに無いため、ページ側が
    `useAppShellOverride()`(`_lib/appShellOverride.tsx`)経由でここへ知らせる。
    未保存確認(`onBeforeLeave`)も同じ経路——`/popup`・`/display` だけが持つ。
*/
import { Suspense, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AppShell } from "../_components/AppShell";
import { breadcrumbItemsForPath, isAppShellHidden, navKeyForPath } from "../_lib/appShellRoute";
import { AppShellOverrideProvider, type AppShellOverride } from "../_lib/appShellOverride";
import { SessionStateProvider } from "../_lib/sessionContext";
import { useRequireSession } from "../_lib/useRequireSession";

function AppLayoutContent({ children }: { children: React.ReactNode }) {
  const sessionState = useRequireSession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlSiteId = searchParams.get("site") ?? "";

  const [override, setOverride] = useState<AppShellOverride>({});
  const siteId = override.siteId ?? urlSiteId;

  const content = (
    <SessionStateProvider value={sessionState}>{children}</SessionStateProvider>
  );

  return (
    <AppShellOverrideProvider value={setOverride}>
      {isAppShellHidden(pathname, siteId) ? (
        // 🔴 `/tags` の0件の初回設定(サイドバーを出す前提の作りではない)。appShellRoute.ts参照。
        content
      ) : (
        <AppShell
          activeNav={navKeyForPath(pathname)}
          siteId={siteId}
          breadcrumbItems={breadcrumbItemsForPath(pathname, siteId)}
          onBeforeLeave={override.onBeforeLeave}
          sessionReady={sessionState === "ready"}
        >
          {content}
        </AppShell>
      )}
    </AppShellOverrideProvider>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // 🔴 `useSearchParams` は Suspense 境界が要る(各ページの `Suspense` 境界と同じ理由)。
  return (
    <Suspense fallback={null}>
      <AppLayoutContent>{children}</AppLayoutContent>
    </Suspense>
  );
}
