/*
  LP に貼る埋め込みタグの文字列を作る(管理画面の「タグ」ページに出すもの)。
  ⚠ 属性名は `packages/embed/src/bridge.ts` の `SITE_ATTRIBUTE`(新名)を読む —— 写しを作ると、
    ローダが読む名前とずれた日に「貼ったのに動かない」タグを配ることになる。
  ⚠ `loader.ts` は import しない(読み込むと管理画面の上でローダが自動起動してしまう)。
*/
import { SITE_ATTRIBUTE } from "../../../packages/embed/src/bridge";

/** 配信元が未設定なら壊れたタグを見せない(null)。 */
export function embedTag(deliveryOrigin: string, siteKey: string): string | null {
  if (deliveryOrigin === "") return null;
  return `<script async src="${deliveryOrigin}/embed/t.js" ${SITE_ATTRIBUTE}="${siteKey}"></script>`;
}
