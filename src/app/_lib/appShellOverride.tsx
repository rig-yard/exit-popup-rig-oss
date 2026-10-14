"use client";

/*
  `/popup`(キャンペーン詳細)・`/display`(表示設定)だけが、`(app)/layout.tsx` の既定値
  (URLから決まる siteId・未保存確認なし)を上書きするための配線。
  `_lib/appShellRoute.ts` のコメント参照: siteId は本体の取得が終わるまで URL に無い
  (`/popup`)。onBeforeLeave は未保存の変更があるページ(`/popup`・`/display`)だけが持つ。
*/
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { LeaveGuard } from "./unsavedChanges";

export type AppShellOverride = { siteId?: string; onBeforeLeave?: LeaveGuard };

type SetOverride = (override: AppShellOverride) => void;

const AppShellOverrideContext = createContext<SetOverride>(() => {});

export const AppShellOverrideProvider = AppShellOverrideContext.Provider;

/**
 * 🔴 `onBeforeLeave` はページ側で毎レンダー新しく作られる関数(`popup/page.tsx`・
 *   `display/page.tsx` の既存の形=`const onBeforeLeave: LeaveGuard = (proceed) => {...}`。
 *   `tests/leave-guard-no-trap.test.ts` がこの宣言の文字面を固定しているため、宣言の形自体は
 *   変えない)。この関数をそのまま effect の依存に入れると、入力するたびに layout へ
 *   setState が飛ぶ。**ref経由で常に最新を指す安定した関数を1つだけ作り**、effect の依存は
 *   「onBeforeLeave を持つかどうか(boolean)」と `siteId` だけにする。
 */
export function useAppShellOverride(override: AppShellOverride): void {
  const setOverride = useContext(AppShellOverrideContext);
  const overrideRef = useRef(override);
  // 🔴 ref への書き込みはレンダー中(関数本体の直接の代入)ではなく `useLayoutEffect` で行う
  //   (`react-hooks/refs`: レンダー中の ref 書き込みはエラー。ペイントの前=次のクリックより
  //   必ず前に更新されるので、「常に最新を指す」という目的は変わらない)。
  useLayoutEffect(() => {
    overrideRef.current = override;
  });

  const stableOnBeforeLeaveRef = useRef<LeaveGuard>((proceed) => {
    const current = overrideRef.current.onBeforeLeave;
    if (current) current(proceed);
    else void proceed();
  });

  const hasOnBeforeLeave = override.onBeforeLeave !== undefined;

  useEffect(() => {
    setOverride({
      siteId: override.siteId,
      onBeforeLeave: hasOnBeforeLeave ? stableOnBeforeLeaveRef.current : undefined,
    });
    return () => setOverride({});
  }, [override.siteId, hasOnBeforeLeave, setOverride]);
}
