/*
  WORKSPACE名(Sidebar.tsx/AppShell.tsx)を、静的書き出しのページ遷移(=ページごとに
  React が丸ごと再マウントされ、`GET /workspace` を毎回取り直す)の間だけタブ内で覚えておく。

  🔴 ページを移るたびに WORKSPACE 名が一瞬「読み込み中…」になっていた。
    `sessionStorage` に最後に取得した名前を書いておき、次のページの初回描画で先にそれを出し、
    裏で `GET /workspace` を取り直して正しい値に揃える(取得自体はこのファイルの外、AppShell.tsx側)。
  ⚠ `sessionStorage` はプライベートブラウジング・ストレージ制限で使えないことがある
    (安全第一原則・SaaS開発ナレッジ)ので、読み書きは必ず try/catch で包み、使えなくても
    画面自体は動く(キャッシュが無いだけで、初回は「読み込み中…」相当の表示に落ちる)。
*/

const STORAGE_KEY = "adpop.workspaceName";

/**
 * キャッシュされた名前を読む。使えない/無い/壊れていれば null。
 * 🔴 `window.sessionStorage` ではなく素の `sessionStorage` を参照する——ブラウザが無い環境
 *   (テスト・SSR相当)では参照自体が `ReferenceError` になり、それも含めて try/catch で拾う。
 */
export function readCachedWorkspaceName(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 取得・変更した名前をキャッシュに書く。失敗しても呼び出し側は気にしない(表示自体は state が持つ)。 */
export function writeCachedWorkspaceName(name: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, name);
  } catch {
    // ストレージが使えない環境では諦める(画面の動作には影響しない)
  }
}

/**
 * 🔴 ログアウトでこのキャッシュが消えないと、同じタブで再度ログインしたとき
 *   (セッションの合間にWORKSPACE名が変わっていた場合など)、新しいGETが終わるまでの一瞬だけ
 *   前のセッションのWORKSPACE名が表示されてしまう(実機で再現確認済み)。ログアウト成功時・
 *   ログイン成功時の両方でこれを呼ぶ(呼び出し側は Sidebar.tsx の `doLogout` と login/page.tsx)。
 */
export function clearCachedWorkspaceName(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ストレージが使えない環境では諦める(そもそも書けていないので消す必要もない)
  }
}
