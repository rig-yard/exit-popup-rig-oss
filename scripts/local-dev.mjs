/*
  `npm run admin:dev` / `delivery:dev` / `*:migrate:local` だけが使う、ローカル確認用の設定と配信元の組み立て(純粋関数)。

  ローカルの配信 Worker は `http://localhost:<port>` で待ち受け、Custom Domain のホスト名には繋がらない。
  そのため `admin:dev` は、管理画面のビルドに埋め込む配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)を
  ローカルの配信 Worker の URL にし、本番を指せる値を持たない別の設定(下の `localWranglerConfig`)を使う。

  deploy 側の保証は変えない: `npm run deploy:admin` は生成した設定(Custom Domain の検査つき)を使い、
  `scripts/check-admin-headers.mjs` は配信元が `https://<配信ホスト>` と完全に一致しなければ止める
  (ローカルの URL は一致しない)。この別設定は `wrangler-run` の `dev` 以外には渡らず、`deploy` は受け付けない。
  仮に deploy へ流用されても、本番の Worker・Custom Domain・D1 を指す値が入っていないので本番は更新できない。
*/

export const DEFAULT_LOCAL_DELIVERY_ORIGIN = "http://localhost:8787";

/** `http://localhost:<port>` または `http://127.0.0.1:<port>` の形だけ(パス・ワイルドカード・他のホストは断る)。 */
export function isLocalOrigin(value) {
  return typeof value === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(value);
}

/**
 * ローカルの配信 Worker の URL。環境変数 `ADPOP_LOCAL_DELIVERY_ORIGIN` で変えられる(形が合わなければ throw)。
 * @param {Record<string, string | undefined>} [env]
 */
export function localDeliveryOrigin(env = process.env) {
  const value = (env.ADPOP_LOCAL_DELIVERY_ORIGIN ?? DEFAULT_LOCAL_DELIVERY_ORIGIN).replace(/\/$/, "");
  if (!isLocalOrigin(value)) {
    throw new Error(`ADPOP_LOCAL_DELIVERY_ORIGIN は http://localhost:<port> の形にする(渡された値: ${JSON.stringify(value)})`);
  }
  return value;
}

/** ローカル専用の Worker 名(本番の名前とは別)。 */
export function localWorkerName(target) {
  return `adpop-${target}-local`;
}
export const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
export const LOCAL_BUCKET_NAME = "adpop-images-local";

/** ローカル専用の設定を使う wrangler の呼び方か(`dev`、または `d1 ... --local` で `--remote` が無いもの)。 */
export function usesLocalConfig(args) {
  const list = (args ?? []).map((arg) => String(arg).split("=")[0]);
  if (list[0] === "dev") return true;
  return list[0] === "d1" && list.includes("--local") && !list.includes("--remote");
}

/**
 * 追跡している設定(仮の値だけが入っている)から、ローカル専用の設定を作る(元は変えない)。
 * 配信と管理画面で D1 の id を同じダミーにするので、ローカルの D1(`.wrangler/state`)を共有できる。
 * 本番を指せる値を持たない: routes は無し・Worker 名は別名・D1 の id と R2 のバケット名はローカル専用のダミー。
 * `deploy.local.json` の値は一切入れない(入力に取らない)。deploy に流用しても、本番の Worker は更新されず
 * 存在しない D1 で失敗する。build.command はビルドだけ(deploy 用の検査は含めない)。
 */
export function localWranglerConfig(trackedConfig, target) {
  const next = structuredClone(trackedConfig);
  next.name = localWorkerName(target);
  delete next.routes;
  next.workers_dev = false;
  next.build = { ...(next.build ?? {}), command: target === "admin" ? "npm run build" : "npm run build:embed" };
  if (Array.isArray(next.d1_databases)) {
    next.d1_databases = next.d1_databases.map((db) => ({ ...db, database_id: LOCAL_DATABASE_ID }));
  }
  if (Array.isArray(next.r2_buckets)) {
    next.r2_buckets = next.r2_buckets.map((bucket) => ({ ...bucket, bucket_name: LOCAL_BUCKET_NAME }));
  }
  return next;
}
