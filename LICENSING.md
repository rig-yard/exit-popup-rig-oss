# ライセンスの分割

EXIT POPUP は **ディレクトリでライセンスを分けている**。

| 場所 | ライセンス | 本文 |
|---|---|---|
| `packages/embed/` (npm 名 `exit-popup-js`) | **MIT** | `packages/embed/LICENSE` |
| **それ以外すべて**(Next.js のサーバー・管理画面・マイグレーション・スクリプト) | **AGPL-3.0** | ルートの `LICENSE` |

Copyright (c) 2026 Takumi Nagano

## なぜ分けるか

- `packages/embed/` は **他人の LP に読み込まれるコード**。コピーレフトだと、貼る側が
  「自分のサイト全体に義務が及ぶのか」を心配して**貼らない理由になる**。ここは摩擦をゼロにする。
- サーバー・管理画面は AGPL-3.0。**自前ホストは自由**にしつつ、改変してホスティング商売にする
  第三者にはソース公開義務が及ぶ。

## 分割を機械で効かせている場所

**AGPL-3.0 と MIT は互換ではない**ので、混ざると後から分離できない。次の2つを CI で毎 PR 見る。

| 検査 | コマンド | 何を見るか |
|---|---|---|
| 依存の向き(第1段) | `npm run check:embed-independence` | **esbuild が入口から実際に解決した依存グラフ**(metafile)の入力が、全部 `packages/embed/` の中にあること |
| 依存の向き(第2段) | 同上 | `packages/embed/` 配下の **TS/JS 系のファイル**(`.ts .tsx .js .jsx .mjs .cjs .mts .cts`。⚠ **`dist/` と `node_modules/` は除く**)を `typescript` の `ts.preProcessFile` で読み、**静的に書かれた import 指定子**(`import type` と triple-slash の参照を含む)が外を指していないこと |
| ライセンス本文 | `npm test`(`tests/license-split.test.ts`) | ルート `LICENSE` に AGPL-3.0 の本文が、`packages/embed/LICENSE` に MIT の本文が、それぞれ**そのまま**在ること |

**なぜ2段あるか**(どちらか片方では抜ける):

| 段 | 見えるもの | **見えないもの** |
|---|---|---|
| 第1段(metafile) | 入口から実際に読まれるコード。**書き方・拡張子・別名に依存しない** | **入口から到達していないファイル** / **`import type`**(バンドル後に消えるので依存グラフに出ない) |
| 第2段(静的走査) | 到達していないファイルも含めた、**上の8拡張子のファイル**(`dist/` `node_modules/` を除く)の静的 import・`import type`・triple-slash | **実行時に文字列を組み立てる `import(変数)`**(静的には何を読むか決まらない)/ **8拡張子に無いファイル** |

⚠ **したがって「一切読んでいない」を保証してはいない。** 保証しているのは
**「入口から到達する依存」+「静的に書かれた import 指定子」**の2つで、
**動的に組み立てた文字列の import は見ていない**。
⚠ 依存の向きは **embed → server を禁止**する片側だけ。逆(server が embed を読む)は
将来ありうるので禁止していない。

## GitHub のライセンス自動判定

ルートの `LICENSE` は **AGPL-3.0 の全文だけ**を置く。冒頭に分割の案内(日本語の前置き)を足すと、GitHub の
自動判定(licensee)が本文の一致率で見るため `NOASSERTION` に落ちることがある。分割の案内は
**このファイルと `README.md` の冒頭**に置く。`tests/license-split.test.ts` が、`LICENSE` の冒頭に案内が
混ざっていないこと(判定を落とした原因側)を固定している。

⚠ この検査は GitHub の判定そのものを測っていない(判定は default branch でしか更新されず、API でしか読めない)。

## 同梱しているフォント

`public/fonts/*.woff2`(IBM Plex Sans / IBM Plex Mono)は **SIL Open Font License 1.1**
(再配布・改変・商用利用が自由なライセンス)。本体のコードのライセンス(MIT / AGPL-3.0)とは別物。
ライセンス全文と、フォントファイルに埋め込まれている著作権表示(IBM Corp.)は [`public/fonts/OFL.txt`](public/fonts/OFL.txt) にある。
