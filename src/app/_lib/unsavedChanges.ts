/*
  ページを離れるときの確認(ポップ編集・設計上の要件)。
  🔴 未保存の判定そのものはここでは作らない。呼び出し側(popup/page.tsx・display/page.tsx)が、
  `variantSync.ts` の baseline 比較と同じ考え方(最後にサーバーと同期した値と今の入力を比べる)で
  `hasUnsavedChanges: boolean` を1つに畳んでから渡す。

  パンくず・ログアウト・ブラウザを閉じる/再読み込みの3経路は、確認の出し方が違う:
  - パンくず・ログアウト: ページの中の操作なので、**既存の確認ダイアログの部品**
    (`UnsavedChangesDialog` = `Modal` の再利用)で確認できる。`LeaveGuard` がその配線。
  - 閉じる・再読み込み: `beforeunload`。ブラウザ自身が出す確認で、文言はカスタマイズできない
    (`preventDefault`/`returnValue` を立てるだけ)。
*/
import { useEffect, useRef } from "react";

/**
 * `proceed`(実際にその操作を行う関数)を、未保存の変更・進行中の操作があるときだけ確認に回す。
 * `blocksLeaving` が false なら確認を挟まずそのまま呼ぶ。
 * true なら呼び出し側(`Header`/`Breadcrumb`)は確認が必要なことを知るだけでよく、
 * **確認そのもの(モーダルの表示・ボタン)はページ側が持つ**(部品を1つに保つため)。
 *
 * 🔴 `proceed` は「実際に離脱(遷移)できたか」を `boolean` で返す。
 *   ログアウトのように `proceed` が失敗して画面に留まる経路があるため、呼び出し側(ページ)が
 *   `bypassOnce()` で武装した `beforeunload` の抑止を、離脱できなかったときに `cancelBypass()`
 *   で解除できるようにする(でないと、次の本当の離脱でも確認が出なくなる)。
 */
export type LeaveGuard = (proceed: () => Promise<boolean> | boolean) => void;

/*
  🔴 ログアウト・401によるログイン送り出し(`Sidebar.tsx`・
  `_lib/useRequireSession.ts`・`_lib/api.ts`)は、`window.location.href = "/login"` を
  **確認無しに実行できる前提**(未保存の入力があっても、ログイン画面へは必ず送る)だが、
  `/popup` に未保存の入力があると `useBeforeUnloadGuard` のリスナーが生きていて、ブラウザの
  `beforeunload` 確認が出てしまい、ログイン送り出しがその場で止まる(確認を無視すれば進めるが、
  利用者に「ログアウトしますか」とは別の、文脈の無い確認が出る)。
  `useBeforeUnloadGuard` が返す `bypassOnce`/`cancelBypass` はReactコンポーネント(ページ)の
  中だけで使える値だが、ログアウト・401はコンポーネント外(`Sidebar.tsx`の中では呼べるが、
  `_lib/api.ts`・`_lib/useRequireSession.ts`はReactフックを持たない素の関数)からも起こる。
  **タブに1つしか無い、モジュール単位のグローバルな1回だけのbypass**を別に持ち、どちらの経路
  からでも呼べるようにする(このタブで同時に有効な`beforeunload`リスナーは、どのページに
  居るかによらず常に最大1本=`attachBeforeUnloadGuard`は現在表示中のページが1つだけ張るため、
  グローバルな1個のフラグで足りる)。
*/
let globalBeforeUnloadBypassArmed = false;

/**
 * ログアウト・401によるログイン送り出しの**直前**に呼ぶ。次の(そしてその1回だけの)
 * `beforeunload` を、未保存の入力があっても確認無しで通す。
 */
export function armGlobalBeforeUnloadBypass(): void {
  globalBeforeUnloadBypassArmed = true;
}

function consumeGlobalBeforeUnloadBypass(): boolean {
  if (!globalBeforeUnloadBypassArmed) return false;
  globalBeforeUnloadBypassArmed = false;
  return true;
}

/**
 * `beforeunload` の実際の DOM 配線(React に依存しない。JSDOM で直接テストできる。
 * `tests/embed-flow.test.ts` と同じ考え方で、React のレンダーを介さずに検証する)。
 * `isBypassed`/`consumeBypass` で「1回だけ黙らせる」フラグの読み書きを外側(フック)に委ねる。
 */
export function attachBeforeUnloadGuard(win: Window, isBypassed: () => boolean, consumeBypass: () => void): () => void {
  function handler(event: Event) {
    if (isBypassed()) {
      // 🔴 以前はここで何もしておらず、一度 bypass すると二度と戻らなかった
      //   (以後の beforeunload が永久に抑止され続けた)。使ったら即座に消費する=「1回だけ」を
      //   文字どおり1回だけにする。
      consumeBypass();
      return;
    }
    if (consumeGlobalBeforeUnloadBypass()) return; // ログアウト・401によるログイン送り出し
    const e = event as BeforeUnloadEvent;
    e.preventDefault();
    e.returnValue = "";
  }
  win.addEventListener("beforeunload", handler);
  return () => win.removeEventListener("beforeunload", handler);
}

/**
 * ブラウザを閉じる・再読み込みする前の確認(`beforeunload`)。
 * ⚠ ブラウザは `beforeunload` のダイアログに任意の文言を出させない(既定の文言は実装依存)ので、
 *   ここでは `preventDefault`/`returnValue` を立てるだけ。
 *
 * 🔴 **実機で確認して直した**: このアプリは静的書き出しなので、パンくず・ログアウトの遷移も
 *   普通の `<a href>`/`location.href` によるページ全体の読み込みで起きる。`UnsavedChangesDialog`
 *   で一度確認を取った直後に、同じ遷移で `beforeunload` のネイティブ確認が**二重に**出た
 *   (Playwright で実測)。`bypassOnce()` を返し、パンくず・ログアウト側が確認を取った直後に
 *   呼んで、その遷移の `beforeunload` だけを黙らせる(閉じる・再読み込み=確認を経由しない経路は
 *   そのまま効く。これも実機で確認した)。
 * 🔴 `bypassOnce()` が戻らない(一度 true にすると永久に `beforeunload`
 *   が抑止され、以降の離脱確認が出なくなる)。`attachBeforeUnloadGuard` 側で「使ったら消費する」形にし、かつ
 *   `cancelBypass()` を公開して、**離脱に失敗した**(例: ログアウトAPIが失敗して画面に残った)
 *   ときに呼び出し側(`popup/page.tsx`)が明示的に武装解除できるようにした。
 */
export function useBeforeUnloadGuard(hasUnsavedChanges: boolean): { bypassOnce: () => void; cancelBypass: () => void } {
  const bypassRef = useRef(false);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    return attachBeforeUnloadGuard(
      window,
      () => bypassRef.current,
      () => {
        bypassRef.current = false;
      },
    );
  }, [hasUnsavedChanges]);
  return {
    bypassOnce: () => {
      bypassRef.current = true;
    },
    cancelBypass: () => {
      bypassRef.current = false;
    },
  };
}

/**
 * 確認ダイアログ(`pendingLeave`)を一度出した**後**、保存(閾値のblur保存・キャンペーン名の保存・
 * パターンの画像アップロード等)が終わって `blocksLeaving`(dirty/busy)が解消したら、
 * 確認ダイアログを閉じるだけで、その場に留まる(遷移は実行しない)。
 *
 * 🔴🔴🔴 設計の結論(同じ型の不具合が3回続いた末): 「保存が終わったら待っていた遷移を
 * 自動で実行する」という発想そのものをやめる。保存は複数の非同期ステップ(アップロード→再取得、等)
 * を経ることがあり、**どの時点の「busy が解消した」が「本当に全部成功した」と同じ意味になるかを
 * 毎回正確に見分けようとすると、見分け損ねる箇所が次々に出てくる**
 * (1回目: busyの解消だけで判定→失敗を「保存できた」と誤認。2回目: hasVisibleErrorを入口にも
 * 使って離脱そのものを封じる閉じ込めを作った。3回目=今回: `VariantCard` のアップロードは
 * `uploadVariantImage` が成功した時点で `setStatus("idle")`(busy解消)するが、その後の
 * `syncImageFromServer`(再取得)がまだ進行中——busyが先に解消し、再取得の失敗はその後に
 * 別個に起きる。「busy解消=成功確定」という前提自体が、複数ステップの処理では成り立たない)。
 *
 * 遷移を自動実行しなければ、**何が成功したか・失敗したかを正確に見分ける必要が無くなる**
 * (見分け損ねる余地そのものを無くす)。保存が終わったら確認だけ閉じて画面に残り、エラーが
 * あればそのまま見える。利用者がもう一度サイドバー等を押せば、その時点で未保存が無ければ
 * 即座に離れられる(`LeaveGuard` の入口=`onBeforeLeave` 自体は元々 `blocksLeaving` だけで
 * 判定している。変えていない)。
 */
export function shouldClosePendingLeave(hasPendingLeave: boolean, blocksLeaving: boolean): boolean {
  return hasPendingLeave && !blocksLeaving;
}
