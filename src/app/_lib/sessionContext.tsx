"use client";

/*
  `useRequireSession()`(`/session` の確認)を `(app)/layout.tsx` で1回だけ呼び、
  各ページはその結果をここ経由で読む。

  🔴 ページを移るたびに `/session` を取り直していた: 以前は各 `page.tsx` が
    自分で `useRequireSession()` を呼んでいた。静的書き出しはページごとに別のHTMLなので、
    フルリロードの間はそれで正しかったが、クライアント側遷移にする以上、呼ぶ場所を
    layout 側の1箇所に畳む必要がある(でないと、遷移そのものはソフトになっても `/session` は
    ページを移るたびに再度飛ぶ)。
*/
import { createContext, useContext } from "react";
import type { SessionState } from "./useRequireSession";

const SessionStateContext = createContext<SessionState>("checking");

export const SessionStateProvider = SessionStateContext.Provider;

/** `(app)/layout.tsx` が1回だけ確認した結果。各ページはこれを読むだけで、自分では確認しない。 */
export function useSessionState(): SessionState {
  return useContext(SessionStateContext);
}
