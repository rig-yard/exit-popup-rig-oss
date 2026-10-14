"use client";

import { useEffect, useState } from "react";
import { getJson } from "./api";
import { clearAllPopupEditSnapshots } from "./popupEditSession";
import { armGlobalBeforeUnloadBypass } from "./unsavedChanges";
import { clearCachedWorkspaceName } from "./workspaceCache";

export type SessionState = "checking" | "ready";

/** 認証済みの画面の先頭で呼ぶ。未認証ならログインへ送る(サーバーが既定で拒否するので、ここは利便性のためだけ)。 */
export function useRequireSession(): SessionState {
  const [state, setState] = useState<SessionState>("checking");
  useEffect(() => {
    let active = true;
    getJson("/session").then((res) => {
      if (!active) return;
      if (res.ok) {
        setState("ready");
      } else {
        // 🔴 未ログインと分かった時点でタブ内キャッシュの
        //   WORKSPACE名を消す(残したまま /login へ送ると、同じタブで次に別アカウントが
        //   ログインしたとき、新しいGETが終わるまでの一瞬だけ前のセッションの名前が見える)。
        clearCachedWorkspaceName();
        clearAllPopupEditSnapshots();
        armGlobalBeforeUnloadBypass();
        window.location.href = "/login";
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
