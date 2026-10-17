# 自前ホスト: Cloudflare に立てる

EXIT POPUP を自分の Cloudflare アカウント(Workers + D1 + R2)に立てる手順です。機能と制限は
[README.md](../README.md) を見てください。

> この手順の「検証済み」の範囲: クリーンな checkout からの `npm ci` → `npm run build` →
> 両 Worker の `wrangler deploy --dry-run` → `wrangler d1 migrations apply --local` は、CI
> (`.github/workflows/ci.yml`)が毎回通しています。**Cloudflare 側に実リソースを作る手順
> (§2〜§8)は CI では通していません。** 各段に「確かめ方」を書いたので、その場で確認してから次へ進んでください。

## 0. 前提

- Node.js 24
- Cloudflare アカウント1つ(二要素認証を有効にしておく)
- 自分が管理するドメイン1つ(Cloudflare の DNS に載っていること)。配信用と管理画面用の
  **ホスト名を2つ**使います(例: `adpop.<自分のドメイン>` と `adpop-admin.<自分のドメイン>`)
- デプロイに使う API トークンは **D1・R2・Workers に絞る**(全権のトークンを使わない)
- パスワードと secret の生成・投入(§7)は、**自分の端末で人が行ってください**。
  `npm run admin:hash` は平文のパスワードを1回だけ標準出力に出すので、記録が残る場所
  (自動化ツールの実行ログなど)では実行しないでください。

## 1. checkout

```bash
git clone <このリポジトリの URL>
cd adpop
npm ci
```

## 2. 自分の値を `deploy.local.json` に書く(追跡されないファイル)

リポジトリの `wrangler.delivery.jsonc` / `wrangler.admin.jsonc` は、**仮の値**
(`adpop.example.com` / `adpop-admin.example.com` / `REPLACE_WITH_YOUR_D1_DATABASE_ID`)しか持ちません。
**自分の値をこれらのファイルに直接書かないでください**(仮の値以外が入っていると、deploy・`migrate:remote` は生成の前に止まります)。

自分の値は、リポジトリの直下に置く **`deploy.local.json`**(`.gitignore` 済み。コミットされません)に書きます。

```json
{
  "deliveryHost": "adpop.<自分のドメイン>",
  "adminHost": "adpop-admin.<自分のドメイン>",
  "databaseId": "<§3 の出力の database_id>"
}
```

- 3つのキーはすべて必須で、これ以外のキーは受け付けません。
- ホスト名は `https://` やパス・ポート・ワイルドカードを付けない素のホスト名。配信と管理画面で**別の名前**にします。
- `npm run deploy:delivery` / `npm run deploy:admin` / `npm run migrate:remote` は、このファイルから
  `wrangler.delivery.generated.jsonc` / `wrangler.admin.generated.jsonc`(`.gitignore` 済み)を作り、
  それを使います。手で作り直したいときは `npm run config:render`。
- `deploy.local.json` が無いと、`npm run deploy:*`・`migrate:remote`・`wrangler:*`・`admin:hash` はどれも生成せずに止まります。
- ホスト名は大文字小文字を区別せず、生成した設定には小文字で書かれます。
- 生成した設定を `wrangler` に直接渡さないでください(古い生成物や未生成のものを使ってしまいます)。
  補助コマンド(Time Travel・`PRAGMA optimize`・secret)は、毎回その場で設定を作り直す
  `npm run wrangler:delivery -- <引数>` / `npm run wrangler:admin -- <引数>` で打ちます。
  使えるのは `d1` と `secret` だけで、`deploy` や設定の差し替え(`-c`・`--config`・`--env`・`--name`)は断られます。

## 3. D1 を作る

```bash
npx wrangler d1 create adpop
```

出力の `database_id` を `deploy.local.json` の `databaseId` に書きます(両 Worker で同じ値を使うので、
書く場所は1か所です)。

- 仮の値のままだと deploy は止まります(`scripts/database-id-guard.mjs`)。
- Time Travel は常時有効です。移行の前に時点を控えておくと、戻すときの目印になります:
  ```bash
  npm run wrangler:delivery -- d1 time-travel info adpop
  ```

## 4. R2 バケットを作る

```bash
npx wrangler r2 bucket create adpop-images
```

- **公開設定(Public Development URL・独自ドメインの接続)には触らない。** 画像は配信の Worker の
  `/img/<キー>` が R2 のバインドから返すので、バケットを公開する理由がありません。
- `wrangler.*.jsonc` の `r2_buckets` はバインド名(`IMAGES`)とバケット名(`adpop-images`)だけを持ちます。

## 5. マイグレーションを当てる(deploy の前)

```bash
npm run migrate:remote
```

- `deploy.local.json` から設定を作り、`databaseId` の検査を通したうえで
  `wrangler d1 migrations apply adpop --remote`(生成した管理画面の設定つき)を実行します(追加の引数は受け付けません)。
- `--remote` は必ず付く形になっています。`wrangler d1 migrations apply` の `--local` / `--remote`
  どちらも付けなかったときの既定は、公式文書で確認できていないため、手で打つ場合も明示してください。
- 配信と管理画面は同じ D1 を見るので、適用は1回で足ります。もう一度流して「No migrations to apply」になれば完了です。

### PRAGMA optimize(ANALYZE)

D1 は `ANALYZE` の結果を自動更新しません(Cloudflare の
[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) は、スキーマ変更の後に
実行することを勧めています)。マイグレーションを当てたら実行してください:

```bash
npm run wrangler:delivery -- d1 execute adpop --remote --command "PRAGMA optimize;"
```

## 6. 独自ドメインの Custom Domain で受ける(`workers.dev` は使わない)

配信ホストと管理画面ホストは、**Custom Domain** で受けます。`workers.dev` も zone の routes も使いません。
埋め込みタグの `src`(配信ホスト)は、配ったタグの数だけ第三者の LP に JS を配る場所で、貼られたタグは
こちらから回収できません。ホスト名は一度配ったら変えない前提で選んでください。

- 両 `wrangler.*.jsonc` の `routes` は、`custom_domain: true` を付けたホスト名1件だけです。
- zone の routes(パターンで受ける方式)は使いません。同じホスト名に一致する zone の route は
  Custom Domain の Worker より前に走る(Cloudflare 公式文書「Custom Domains」)ため、広い pattern を持つ
  別の Worker を1つ増やすだけで通信を横取りできる経路になります。同じゾーンに他の Worker の `routes` を足さないでください。
- `workers_dev` は両方 `false`。ダッシュボードで切るだけでは次の deploy で復活する
  (Cloudflare 公式文書「workers.dev」)ため、設定ファイルに持たせています。
- deploy 前の検査(`scripts/check-custom-domain.mjs`)が、これらを機械で見ます:
  ①`workers_dev` が `false` ②routes が Custom Domain のホスト名1件だけ(キーは `pattern` と `custom_domain` のみ)
  ③ホスト名が素のホスト名で、仮の値(`example.com` 系)ではない ④配信と管理画面で別のホスト名。
  管理画面のビルドでは、さらに `NEXT_PUBLIC_DELIVERY_ORIGIN` が `https://<配信ホスト>` と一致するかを見ます
  (`npm run deploy:admin` が未設定なら自動で設定します)。

### 初めて立てる手順

1. 使うドメインの DNS を、この Cloudflare アカウントに向ける(ネームサーバを Cloudflare に向ける)。
2. §7 の手順で両 Worker を deploy する。`routes` に書いたホスト名ごとに、Cloudflare が証明書を自動で発行します。
3. **証明書の発行が終わり、HTTPS で 200 が返ることを確かめてから**、埋め込みタグを配る・管理画面のログインを人に伝える。
   発行には時間がかかることがあり、終わるまで HTTPS は失敗します。
4. **DNSSEC を有効にする**(ダッシュボード)。最初のタグを配る前に。DNS のキャッシュ汚染で配信先を差し替えられる経路を閉じるためです。
5. それ以後、配信ホスト名と配信 Worker の名前(`adpop-delivery`)は変えない。変えると、配ったタグが全部壊れます。

## 7. デプロイする

**正規の deploy 経路は、次の2つの npm script だけです。** `wrangler deploy` を直接呼ばないでください。

```bash
npm run deploy:delivery   # 配信の Worker
npm run deploy:admin      # 管理画面の Worker
```

- どちらも `deploy.local.json` から設定を作り、`build.command` の検査を通してから deploy します。
  追加の CLI 引数は受け付けません(`scripts/deploy-args-guard.mjs`)。
  Wrangler の `--route` / `--domain` などで Custom Domain の構成を迂回させないためです。
  ⚠ これは運用の約束で、`wrangler` を直接呼ぶこと自体を禁止する仕組みではありません。
- 配信の `build.command`: 埋め込みの束ね直し → 埋め込みのサイズ上限 → ライセンス境界 → `database_id` の検査 → Custom Domain の検査。
- 管理画面の `build.command`: 埋め込み束ね → `next build` → `out/_headers` の CSP 組み立て →
  ①CSP に `unsafe-inline` / `unsafe-eval` が無い ②`NEXT_PUBLIC_DELIVERY_ORIGIN` が配信ホストと一致 ③その値が CSP の
  `img-src` とビルド出力の両方に入っている ④`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` が揃っている
  ⑤`database_id` が両方で一致し仮の値ではない ⑥両 Worker とも `workers_dev: false`・zone の routes 無し・Custom Domain の構成が正しい。
- `build.command` は `wrangler dev` でも走ります(Wrangler の仕様)。
- 検査は、環境変数 `ADPOP_DELIVERY_CONFIG` / `ADPOP_ADMIN_CONFIG` が指す設定ファイルを読みます。
  `npm run deploy:*` は自動で生成物を指します。**未設定のときは追跡されている仮の値の設定を読むので、検査は失敗します。**
  `wrangler deploy` は自分で呼ばないでください(上の約束)。
- CI(`.github/workflows/ci.yml`)は、`deploy.local.json` が無い状態で lint・型・テストを通します。deploy の dry-run だけは、
  CI の作業領域の中で CI 専用の値(予約済みの `.test` ドメイン)の `deploy.local.json` を作って走らせます(コミットはされません)。
  dry-run は Cloudflare に接続しないので、CI に認証情報は要りません。

### Cloudflare Access(管理画面の前に必須)

管理画面の deploy の直後に、Cloudflare Access を設定してください。管理画面は配信ホストと同じ登録ドメインの
サブドメインに置く構成なので、Access はこの構成の条件の1つです(README「管理画面のログインと守り」)。

1. Cloudflare ダッシュボード → **Workers & Pages** → `adpop-admin` → **Access** タブ →
   **Protect this Worker behind Access** → **All traffic**
   (一次: [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/))。
   Worker に紐づく Custom Domain も自動で保護されます。WebSocket を使う Worker では使えませんが、管理画面は使っていません。
2. **Authentication policy** で、運用者本人のメールアドレス(ワンタイムコード)か Google アカウントだけを許可し、**Apply Access**。
3. **確かめ方**: 未ログインのプライベートウィンドウで `https://<管理画面ホスト>/` を開き、EXIT POPUP のログイン画面ではなく
   **Cloudflare Access の認証画面**が先に出ること。
4. 料金: [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/) は無料プランを案内していますが、
   具体的な無料の人数とカード登録の要否は確認できていません(未確認)。サインアップの画面で確かめてください。

Access を設定しても、EXIT POPUP 自身のパスワード・Origin 検査は外さないでください(Access の設定ミスで素通りになったときの2枚目の守りです)。

## 8. secret を投入する(自分の端末で)

```bash
npm run admin:hash
#   表示されたパスワードはパスワード管理ツールへ保存する(この画面以外には出ません)
npm run wrangler:admin -- secret put ADMIN_PASSWORD_HASH    # ← 表示された値
npm run wrangler:admin -- secret put ADMIN_RATE_LIMIT_KEY   # ← 表示された値
npm run wrangler:admin -- secret put ADMIN_OWNER_ID         # ← 表示された値(最初の1回だけ)
npm run wrangler:admin -- secret put ADMIN_EMAIL            # ← ログインに使うメールアドレス
```

- **§7 で管理画面の Worker を deploy した後に行います。** `wrangler secret put` は、対象の Worker が Cloudflare 上に
  まだ無いと空の draft Worker を作る、という利用者の報告があります(Cloudflare の公式文書には明記が見つからず、
  この手順では試していません)。先に deploy しておけば、この中間状態を避けられます。
- secret を入れる前の管理 API は 503 を返します(secret の欠けを検出して閉じる)。認証が開いたまま動く順序にはなりません。
- ローカル開発用の `.dev.vars` は、本番の secret と**別の値**で作ってください。

### パスワード管理ツールの設定

管理画面は配信ホストと同じ登録ドメインのサブドメインに置くため、一致方式が「登録ドメイン単位」のツールでは、
同じドメインの別のサブドメインにもこの項目が自動入力の候補として出ます。

- 一致方式を「ホスト完全一致」に絞れるツール: EXIT POPUP の管理画面の項目だけ、ホスト完全一致に設定する。
- 絞れないツール(ブラウザ内蔵の保存機能など): 候補が出ても、アドレスバーのホストが管理画面ホストに完全に一致していることを
  目で確認してから選ぶ。

## 9. 動作確認(外形)

- 本番で1回ログインする(本番の PBKDF2 反復上限はローカルの wrangler では再現できません)
- 未認証で `GET /api/admin/sites` を叩き、401 が返ること
- 画面の応答ヘッダに `Content-Security-Policy` があること
- R2 の公開(Public Development URL・カスタムドメイン)が有効になっていないこと(ダッシュボードで確認)
- `npm run wrangler:admin -- secret list` に4つの名前(`ADMIN_PASSWORD_HASH` /
  `ADMIN_RATE_LIMIT_KEY` / `ADMIN_OWNER_ID` / `ADMIN_EMAIL`)が出ること
- Cloudflare Access が効いていること(§7 の確かめ方)
- 証明書が発行され、`curl -I https://<配信ホスト>/embed/t.js` と `curl -I https://<管理画面ホスト>/` で
  TLS ハンドシェイクが成功すること
- 過去にこのアカウントで同じ Worker を `workers.dev` で deploy したことがあれば、その旧 URL が応答しなくなっていること
- Cloudflare 側の routes が0件・各 Worker の Custom Domain が1件だけであること
  (ダッシュボードの Workers & Pages → 対象の Worker → Settings → Domains & Routes。
  API: [List Routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/) /
  [List Worker Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/))。
  `npm run deploy:*` を通さない経路で意図しない route が増えていないかを、Cloudflare 側の実際の状態から見る最後の確認です。
- `preview_urls: false` / `workers_dev: false` が設定どおりであること(Version URL を無効化し、独自ドメインだけで出す)

## 10. すでに動いている環境を更新するとき

**順番を守ってください。** 新しい Worker を、マイグレーションを当てる前に deploy すると、新しい表がまだ無いため
設定を読むクエリが失敗し、配信は 502(出せない)、管理画面は該当の画面がエラーになります。

1. 管理画面での変更を止める(運用者に、設定を変えないよう伝える)。古い管理画面の Worker が動いている間の保存は、
   新しい版では読まれない場所に書かれる可能性があります。
2. `npm run migrate:remote`(まだ当てていないファイルだけが順に当たります)
3. `npm run deploy:admin`
4. `npm run deploy:delivery`
5. 確認する: 配信の設定取得(`GET /api/v1/config?site_key=...`、許可された Origin から)が 200 で返ること。
   管理画面の表示設定が、更新前と同じ内容で表示されること。
6. 管理画面での変更を再開する。

## ローカルで動かす(Cloudflare のアカウントは要りません)

`npm run delivery:dev` / `npm run admin:dev` / `npm run admin:hash` も、deploy と同じく `deploy.local.json` から作った設定を使います
(追跡している `wrangler.*.jsonc` を直接 wrangler に渡すと、`build.command` の検査が仮の値のままで落ちるためです)。
ローカルで動かすだけなら、**予約済みの `.test` ドメインの仮の値**でかまいません(実在しなくてよく、`workers.dev` は使えません)。

```json
{
  "deliveryHost": "adpop.local.test",
  "adminHost": "adpop-admin.local.test",
  "databaseId": "00000000-0000-4000-8000-000000000000"
}
```

これを `deploy.local.json` として置いてから、README の「動かし方(開発)」の順に進めてください。
`delivery:dev` は `http://localhost:8787`、`admin:dev` は `http://localhost:8788` で待ち受けます(上のホスト名は設定の検査を通すための値で、ローカルでは使われません)。

`admin:dev` は、管理画面が出す画像の URL と埋め込みタグの配信元を、ローカルの配信 Worker(既定 `http://localhost:8787`)にして書き出します。
`dev` とローカルの D1 へのマイグレーション(`d1 ... --local`)は、別のファイル(`wrangler.<admin|delivery>.local.generated.jsonc`、gitignore 済み)の設定で動きます。
この設定は本番を指せる値を持ちません(routes なし・Worker 名は `adpop-<admin|delivery>-local`・D1 の id と R2 のバケット名はローカル専用のダミー・`deploy.local.json` の値は入らない)。
`npm run deploy:admin` の検査は変わらず、配信元が `https://<配信ホスト>` と完全に一致しなければ止まります。
配信側のポートを変えるときは、`ADPOP_LOCAL_DELIVERY_ORIGIN=http://localhost:8799 npm run admin:dev` のように配信元も合わせます(`-- --port <port>` でポートを渡せます)。
`dev` に `--remote` は渡せません(ローカルの確認用です)。

## 補足

### Cookie に `Domain` 属性を付けない

`Domain=<登録ドメイン>` の Cookie は同じゾーンの全サブドメインに送られます。管理画面のセッション Cookie は
`__Host-` 接頭辞(`Domain` を付けられない)です(現在の実装。`src/admin/cookie.ts`)。変更しないでください。

### D1 の1日の書き込み上限

- Workers Free の D1 は、1日 100,000 行の書き込み / 500 万行の読み取りが上限です
  (一次: [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/))。
- イベント1件の投入(`fire`)は表1行 + 索引4本で約5行の書き込みになる見込みです(索引の数え方からの**推定**。計測していません)。
  この数え方では、**偽造イベント約2万件**で無料の書き込み枠が尽きる見込みです。
- 尽きると、アカウントの D1 全体に問い合わせできなくなります。配信は fail-closed(LP は壊れず、ポップが出ないだけ)。
  管理画面はログインもできなくなります。UTC 0 時まで戻りません。
- **現在の制限: イベント投入にレート制限はありません。** 自分の LP だけに配る間はこの限界を受け入れる判断もあり得ますが、
  他人の LP にタグを配る前に、レート制限を入れてください。正規の流量だけでも、表示1回 ≈ 15 行の見込みで
  1日 約 6,000 表示(推定)で枠に届くので、使う人数が増えたら Workers Paid への切り替えも検討してください。
