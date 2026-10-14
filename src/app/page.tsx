"use client";

/*
  ルート。セッションが無ければ /login。
  🔴 1インストール=1サイトになり `/sites`(複数サイトの一覧)は無くなった。
    サイトが0件なら「タグの設置」の初回の設定(許可ドメインを入れるとサイトができる)へ、
    1件あればそのサイトのダッシュボードへ送る(静的書き出しなので判定はクライアント側)。
*/
import { useEffect } from "react";
import { getJson } from "./_lib/api";
import type { ApiSite } from "./_lib/types";

export default function Home() {
  useEffect(() => {
    getJson("/session").then(async (session) => {
      if (!session.ok) {
        window.location.href = "/login";
        return;
      }
      const sites = await getJson<ApiSite[]>("/sites");
      if (sites.ok && sites.data.length > 0) {
        window.location.href = `/dashboard?site=${sites.data[0].id}`;
      } else {
        window.location.href = "/tags";
      }
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="sr-only">EXIT POPUP - RIG</h1>
    </main>
  );
}
