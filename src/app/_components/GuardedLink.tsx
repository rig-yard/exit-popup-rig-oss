"use client";

/*
  離脱ガードを通る `<a>`。
  🔴 以前は「パンくず」「ナビ」がそれぞれ別々に同じ分岐(onBeforeLeaveがあれば
  preventDefault→onBeforeLeave経由、無ければ素のリンク)を書いていて、新しく足したリンク
  (サイドバーの「タグの設置」カード・サイト切替の「すべてのサイトを管理」)がこの分岐から漏れ、
  ポップ編集中の未保存確認を通らずに離脱できてしまっていた。
  **ガードの判定ロジックを `resolveGuardedClick`(`_lib/guardedLink.ts`)に1本化**し、`<a>` は
  この `GuardedLink` を経由させる。`<button>` で遷移するサイト切替の候補一覧だけは、この
  コンポーネントの形にできないため `resolveGuardedClick` を直接呼ぶ(`SiteSwitcher.tsx`)。

  🔴 以前はクリックの種別を問わずガードしていたため、
    ポップ編集中に Command/Ctrl+クリックで新しいタブに開こうとしても、確認モーダルの後に
    **いま開いている編集タブ自体**が移動してしまっていた。主ボタン・修飾キーなしのクリックだけ
    ガードし、それ以外(修飾キー・中クリック等・`target≠_self`・`download`)は `<a>` の
    既定の動作(新しいタブ・ウィンドウで開く等)に任せる(判定は `resolveGuardedClick` に集約)。

  🔴 ページを移るたびにサイドバーが作り直される: 以前は主ボタン・修飾キーなしの
    クリックでも `onBeforeLeave` が無ければ `preventDefault` せず、素の `<a>` の既定の
    ナビゲーション(=ページ全体の読み込み直し)に任せていた。それだと `(app)/layout.tsx` に
    1回だけ置いた `AppShell` も毎回作り直されてしまう。ダッシュボード・デザイン一覧・
    タグの設置(未保存を持たない3画面)同士の遷移は、特殊クリックでなければ常に
    `preventDefault` し、Next のルーター(`router.push`)でソフト遷移する。

  🔴 ブラウザの「戻る」が `beforeunload` を
    発火させるかは「どう離れるか」ではなく「どう来たか」で決まる——一度もフルリロードを
    挟まずソフト遷移で来たページは、同じ文書が続いているため「戻る」は常にその場の
    `popstate` として処理され `beforeunload` は発火しない(実機 Playwright で確認)。
    当時は `/display`・`/popup` だけを「出入りの両方がフルリロードの境界」にして逃げたが、
    それがこの2画面だけサイドバーがちらつく原因になっていた。

  🔴 境界そのものを撤去した。`/display` は自動保存にして「未保存」を無くし、
    `/popup` は編集中の入力(キャンペーン名・パターンの編集モード・下書き)を `sessionStorage`
    に保存して、ソフト遷移で一度アンマウントされても戻ってきたら復元する(`_lib/popupEditSession.ts`)。
    確認が無くても入力が消えないので、`beforeunload`(タブを閉じる・外部へ移る・再読み込みの
    経路だけ。`_lib/unsavedChanges.ts`。変更していない)以外の離脱確認は不要になった——
    この `GuardedLink` を経由する遷移(ダッシュボード・デザイン一覧・キャンペーンの中・表示設定・
    タグの設置、どの組み合わせでも)は特殊クリックでなければ常に `router.push`(ソフト遷移)にする
    (ログイン・ログアウト・セッション切れの `/login` への送り出しは対象外。元から `GuardedLink` を
    経由していない=`_lib/useRequireSession.ts`・`login/page.tsx`・`_lib/api.ts` 参照)。
*/
import { useRouter } from "next/navigation";
import type { LeaveGuard } from "../_lib/unsavedChanges";
import { isSpecialClick, resolveGuardedClick } from "../_lib/guardedLink";

export function GuardedLink({
  href,
  onBeforeLeave,
  onBeforeNavigate,
  className,
  children,
  ...rest
}: {
  href: string;
  onBeforeLeave?: LeaveGuard;
  /** ガードの成否に関わらず、クリックした瞬間に呼ぶ(例: ドロワーを閉じる)。 */
  onBeforeNavigate?: () => void;
  className?: string;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className" | "children" | "onClick">) {
  const router = useRouter();

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    const click = {
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      button: event.button,
      target: rest.target,
      hasDownload: rest.download !== undefined,
    };
    // 🔴 全ページ同士の遷移を常にソフト(router.push)にする(ファイル先頭のコメント参照)。
    const navigate = (target: string) => router.push(target);
    const decision = resolveGuardedClick(href, onBeforeLeave, navigate, click);
    onBeforeNavigate?.(); // ガードの成否・特殊クリックかに関わらず呼ぶ(例: ドロワーを閉じる)
    if (isSpecialClick(click)) return; // 特殊クリック = 素の <a> のまま(新しいタブ等、既定のナビゲーションに任せる)
    event.preventDefault();
    if (decision.guarded) {
      onBeforeLeave?.(decision.proceed);
    } else {
      // onBeforeLeave が無い = 確認を挟まず即座に遷移する(挙動は以前のまま、遷移の方法だけ変える)
      navigate(href);
    }
  }

  return (
    <a href={href} className={className} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
