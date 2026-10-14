"use client";

/*
  互換ページ。1インストール=1サイトで複数サイトの一覧
  `/sites` は無くなったが、静的書き出し(`output: "export"`)なのでサーバー側のredirect/rewriteを
  持てず、古いブックマーク・ブラウザ履歴・外部リンクが指すこの URL は何もしなければ静的 404 になる。
  `src/app/site/page.tsx`(旧 `/site?id=...` の互換)と同じ形で、ホーム(`/`)へのクライアント側の
  薄い転送だけを残す。ホーム側が「唯一のサイトへ送る/タグの設置の初回設定へ送る」判定を持つ。
*/
import { useEffect } from "react";

export default function SitesRedirectPage() {
  useEffect(() => {
    window.location.href = "/";
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="sr-only">EXIT POPUP - RIG</h1>
    </main>
  );
}
