/*
  許可ドメインの追加・削除(タグの設置画面)が PUT /sites/:id の成否・直後の再取得(GET)の成否を
  どう扱うかの判定。

  🔴 以前は PUT の成功を `site.allowedOrigins` へ反映せず、直後の再取得(`load()`)の成功だけを
    頼りにしていた。PUT は成功したのに直後の GET(再取得)が失敗すると、画面の `site` が古いまま・
    排他(`originBusy`)だけが解除され、**次の追加・削除がその古い配列を丸ごと PUT して
    直前の成功を上書きしてしまっていた**(例: ドメインAを追加→PUT成功→直後のGETが失敗→
    画面はまだAを追加する前の配列のまま→続けてドメインBを削除すると、Aを含まない配列が
    PUTされ、Aの追加が無かったことになる)。

  **PUT の成否だけを正とする**。PUT が成功した時点で、送った配列
  (`nextOrigins`)をそのまま次の状態として確定させる。直後の再取得は「表示の念押し」
  (サーバー側で他から同時に変更されていないかの確認)でしかなく、その成否には
  `allowedOrigins` の正しさを依存させない——再取得が失敗しても、直前のPUTで確定させた
  配列をそのまま使い続ける。

  このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照)ため、
  `pageLoad.ts`/`latestWins.ts` と同じ考え方で、この判定をDOM・React無しの純粋関数として持つ
  (`originsSave.test.ts`)。`tags/page.tsx` はこの関数に実際の `PUT`/`GET` 呼び出しを注入して呼ぶ。
*/

export type OriginsSaveResult = { ok: true; allowedOrigins: string[] } | { ok: false; error: string };

export type OriginsSaveDeps = {
  /** `PUT /sites/:id`(名前は呼び出し側が既に組み込んで渡す)。 */
  put: (nextOrigins: string[]) => Promise<{ ok: boolean; status?: number }>;
  /**
   * 保存直後の「表示の念押し」の再取得。失敗しても例外を投げない(`ok: false`)——
   * その場合は呼び出し元が送った `nextOrigins` をそのまま使う(このファイルの主旨)。
   */
  reload: () => Promise<{ ok: boolean; allowedOrigins?: string[] }>;
};

/**
 * @param nextOrigins 今回のPUTで送る配列(呼び出し側が「今の画面の値」から計算済みのもの)
 */
export async function saveOrigins(nextOrigins: string[], deps: OriginsSaveDeps): Promise<OriginsSaveResult> {
  const putResult = await deps.put(nextOrigins);
  if (!putResult.ok) {
    return {
      ok: false,
      error: putResult.status === 400 ? "入力内容を確認してください" : "保存できませんでした。もう一度お試しください。",
    };
  }
  // 🔴 PUTが正。再取得を待つ前に、送った値を確定値として扱う(再取得の成否に依存しない)。
  let allowedOrigins = nextOrigins;
  const reloadResult = await deps.reload();
  if (reloadResult.ok && reloadResult.allowedOrigins) {
    // 再取得が成功すれば、サーバー側の最新値(他で同時に変更されていた場合も含む)に揃える。
    allowedOrigins = reloadResult.allowedOrigins;
  }
  return { ok: true, allowedOrigins };
}
