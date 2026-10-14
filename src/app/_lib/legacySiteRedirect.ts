/*
  旧 `/site?id=...` の互換転送先。
  DOM・Reactに依存しない純粋関数にして、転送先の文字列をテストで固定できるようにする。
  🔴 1インストール=1サイトになり `/sites`(一覧)が無くなったため、id が無いときは
    ホーム(`/`)の判定(セッション確認→唯一のサイトかタグの設置の初回設定へ)に委ねる。
*/
export function legacySiteRedirectTarget(siteId: string): string {
  return siteId === "" ? "/" : `/popups?site=${siteId}`;
}
