# exit-popup-js(埋め込みスクリプト・MIT)

**このディレクトリだけが MIT。** リポジトリの他は AGPL-3.0(ルートの `LICENSE` / `LICENSING.md`)。

## 貼り方

```html
<script async src="https://<配信ホスト>/embed/t.js" data-exit-popup-site="<サイトキー>"></script>
```

**旧名・当面維持**: `data-adpop-site` 属性・`/embed/adpop.js`・`?adpop_preview=1` を使った既存のタグも動く。
新旧の両方が付いたときは、新名が空でなければ新名が勝つ(空なら旧名)。

**配信ホストはタグの `src` から読む。**コードに直書きしていないので、ホストを変えたら
タグを貼り替えるだけで移せる。⚠ サイトキーは **HTML に出る公開値**で、秘密ではない
(守るのは配信側の**許可ドメイン**)。

## 構成

| ファイル | 役割 | 状態 |
|---|---|---|
| `src/loader.ts` → `dist/t.js` | 全訪問者に配るローダ。タグを読む → 設定を取る → トリガを仕掛ける → 発火したら本体を取りに行く | 動く |
| `src/runtime.ts` → `dist/exit-popup.js`(旧名の `/embed/adpop.js` でも同じ中身を配る) | 発火してから取りに行く本体。Shadow DOM でポップを描き、表示・クリック・閉じるを送る | 動く |
| `src/frequency.ts` | 頻度制御の判定と、遷移先 URL の検査(副作用なし) | — |
| `src/bridge.ts` | ローダと本体をつなぐ**唯一のグローバル**と、配信のパス | — |

### 入っているトリガ

**exit intent(PC のみ)・スクロール・滞在**の3種(`src/bridge.ts` の `IMPLEMENTED_TRIGGERS`)。
⚠ **知らない種類のトリガは黙って無視する**(戻る・無操作・タブ切替は未実装)。
⚠ 配信の応答に複数のパターンがあっても、出すのは**配信できる先頭の1つ**(A/B の割り当ては無い)。

### 入っているポップの型

**テキスト + ボタン**と**画像 / GIF**の2種。チャットボット型は無い。

## 守っている制約

| 制約 | どこで効かせているか |
|---|---|
| **gzip の上限**(ローダ 5KB / 本体 20KB / 合計 25KB) | `npm run check:bundle-size`(CI で毎 PR)。`npm run check:bundle-size` が現在の実測値と上限を表示する |
| **依存ライブラリを入れない**(React も入れない) | `package.json` の `dependencies` は空 + `npm run check:embed-independence` |
| **AGPL 側(サーバー・管理画面)を import しない** | `npm run check:embed-independence`(CI で毎 PR) |
| **描画を止めない**(`document.write` / 同期 XHR を呼ばない) | `tests/embed-safety.test.ts` —— **束ねた出力を実行して**、呼び出しを罠で捕まえる |
| **グローバルを汚さない**(鍵1つ・プロトタイプを触らない) | 同上 |
| **エラーを外に漏らさない**(タグ無し・`localStorage` 例外・`fetch` 例外) | 同上 |
| **配信が落ちても LP は無傷**(fail-closed) | 同上(500 / 403 / 壊れた JSON / ネットワーク断で、DOM に1つも足さない) |

⚠ **これらは束ねた出力(`dist/`)を実行して測っている。**ソースを読んで
「そう書いていない」を確かめるのは**書き方の話**で、**実際に何を呼ぶか**ではない。

## 既知の限界(そのまま書く)

- **`localStorage` が使えない / 消される環境では、頻度制御が効かない。**
  Cookie にも第三者にも逃がさないので、**出しすぎる側の故障**を選んでいる。
- **匿名IDは `crypto` が無ければ `Math.random`** で作る。**暗号的ではない**
  (頻度制御の識別子で、秘密でも認証でもないため)。
- **`(pointer: coarse)` も `navigator.maxTouchPoints` も無い環境は「PC」と数える。**
- ⚠ `private: true` を外す(= npm に publish できる状態にする)のは**公開ゲート**の後。
