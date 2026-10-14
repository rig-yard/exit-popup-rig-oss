#!/usr/bin/env node
/*
  管理画面の CSP を組み立てる純粋関数。
  設計方針(Shadow DOM のプレビュー用の例外あり)。
  実測: Next の静的書き出しは1ページにつきインライン `<script>` を2本出す(中身はビルド時に決まる定数)。

  🔴 手で書き写さない: ハッシュはビルドのたびに実物の HTML から数える(`scripts/build-admin-headers.mjs`)。
  🔴 unsafe-inline・unsafe-eval・ワイルドカードは使わない。
*/
import { createHash } from "node:crypto";

/**
 * HTML 文字列から、`src` 属性を**持たない** `<script>` タグの中身だけを全部取り出す。
 * Next の静的書き出しは RSC のペイロード(`self.__next_f.push(...)`)をこの形で出す(実測)。
 * `src` を持つ外部 script(`_next/static/chunks/*.js`)は対象外(`script-src 'self'` が別途許可する)。
 */
export function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  return scripts;
}

/** CSP の `script-src` に書く `'sha256-<base64>'` の形。中身1文字でも変われば別の値になる。 */
export function scriptHashToken(scriptText) {
  const digest = createHash("sha256").update(scriptText, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

/** 複数 HTML の中身から、重複を除いたハッシュの一覧を作る(決定的な順番 = ソート済み)。 */
export function collectScriptHashes(htmlContents) {
  const set = new Set();
  for (const html of htmlContents) {
    for (const script of extractInlineScripts(html)) {
      set.add(scriptHashToken(script));
    }
  }
  return [...set].sort();
}

/**
 * CSP の骨格。
 * - `default-src 'none'` を起点に、使っている経路だけを明示で許可する。
 * - `script-src` はハッシュだけ(`'unsafe-inline'` は使わない)。
 * - `style-src` は既定 `'self'`(管理画面は外部スタイルシート・自前ホストのフォントのみ。
 *   インラインの `style` 属性は使わない設計——`VariantCard` の進捗バーは `<progress>` の value 属性に
 *   変えてある。globals.css 参照)。🔴 **プレビューだけが例外**: Shadow DOM の
 *   中に `packages/embed/src/popup-view.ts` の `STYLE` を `<style>` の `textContent` として差し込む
 *   (実物と同じ描画コード = `buildPopupView()` をそのまま使うため)。Shadow DOM の隔離は CSS の継承を
 *   止めるだけで CSP の検査対象からは外れない(実測・Chromium。SaaS開発ナレッジ参照)ので、
 *   `styleHashes`(呼び出し側が `STYLE` のハッシュをビルド時に計算して渡す)を足す。渡さなければ
 *   既存どおり `'self'` のみ(後方互換)。
 * - `font-src 'self'`(自前ホストのフォントのみ)。
 * - `img-src` は `'self'` + `blob:`(`VariantCard` が新規の画像パターンのプレビューに
 *   `URL.createObjectURL()` を使う。`blob:` は画像の表示にしか使っていないので `img-src` だけに限定し、
 *   `script-src`/`connect-src` 等には足さない)に加えて、設定済みなら配信の Worker のオリジン
 *   (保存済みパターンのサムネイル。delivery.ts 参照)。
 * - `connect-src 'self'`(管理 API は同じオリジン)。
 * @param {{ scriptHashes: string[], styleHashes?: string[], deliveryOrigin: string | null }} params
 */
export function buildCsp({ scriptHashes, styleHashes = [], deliveryOrigin }) {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  const styleSrc = ["'self'", ...styleHashes].join(" ");
  const imgSrc = ["'self'", "blob:", ...(deliveryOrigin ? [deliveryOrigin] : [])].join(" ");
  return [
    `default-src 'none'`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `font-src 'self'`,
    `img-src ${imgSrc}`,
    `connect-src 'self'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
  ].join("; ");
}
