#!/usr/bin/env node
/*
  管理者のパスワードと、管理画面の Worker の秘密を作る。

  🔴 **パスワードは人が選ばない**: 128 ビットの乱数を base32(26 文字)にして、**この1回だけ**表示する。
    「自分で決める」モードは置かない(人が選ぶと、ハッシュが漏れたときのオフライン総当たりに弱い)。
  出すもの:
    ・ADMIN_PASSWORD_HASH  = pbkdf2-sha256$100000$<salt>$<hash>
    ・ADMIN_RATE_LIMIT_KEY = 試行回数の鍵を作る HMAC の鍵(32 バイトの乱数)
    ・ADMIN_OWNER_ID       = 所有者の id(**最初の1回だけ**使う。変えると、それまでのデータが見えなくなる)
  ⚠ 値はここで表示するだけで、ファイルには書かない。`wrangler secret put` に貼る(ローカルは `.dev.vars`)。
  🔴 表示するコマンドは `npm run wrangler:admin -- secret put ...`(`deploy.local.json` を重ねた設定を毎回作ってから打つ)。
    追跡している `wrangler.admin.jsonc` は仮の値で、同じ名前(`adpop-admin`)の本物の Worker に当たってしまうので使わない。
    `deploy.local.json` が無い・壊れているときは、パスワードも表示せずに止まる。
  ⚠ パスワードを変えるとき: もう一度走らせ、ADMIN_PASSWORD_HASH だけを置き直す(古いセッションは全部無効になる)。
*/
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { renderGeneratedConfigs } from "./deploy-config.mjs";

const ITERATIONS = 100_000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export async function hashPassword(password, salt = webcrypto.getRandomValues(new Uint8Array(16))) {
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
}

export async function generateSecrets() {
  const password = base32(webcrypto.getRandomValues(new Uint8Array(16)));
  return {
    password,
    passwordHash: await hashPassword(password),
    rateLimitKey: base64url(webcrypto.getRandomValues(new Uint8Array(32))),
    ownerId: webcrypto.randomUUID(),
  };
}

/** 管理者の秘密を登録するコマンド(4つ)。`wrangler:admin` は呼ぶたびに生成した設定で wrangler を打つ。 */
export function secretCommands(secrets) {
  const put = (name) => `npm run wrangler:admin -- secret put ${name}`;
  return [
    `${put("ADMIN_PASSWORD_HASH")}    ← ${secrets.passwordHash}`,
    `${put("ADMIN_RATE_LIMIT_KEY")}   ← ${secrets.rateLimitKey}`,
    `${put("ADMIN_OWNER_ID")}         ← ${secrets.ownerId}   (最初の1回だけ。既に置いてあれば置き直さない)`,
    `${put("ADMIN_EMAIL")}            ← ログインに使うメールアドレス`,
  ];
}

/** 設定が作れなければ何も表示せず 1 を返す(秘密を作る前に確かめる)。 */
export async function run({ render = renderGeneratedConfigs, log = console.log, logError = console.error } = {}) {
  try {
    render();
  } catch (error) {
    logError(`NG  ${error instanceof Error ? error.message : String(error)}`);
    logError("    deploy.local.json を用意してから、もう一度実行してください(docs/deploy.md §2)。");
    return 1;
  }
  const s = await generateSecrets();
  log(`
管理者のパスワード(この1回だけ表示します。パスワード管理ツールに保存してください):

  ${s.password}

次を順に実行し、聞かれたら右の値を貼ってください:

  ${secretCommands(s).join("\n  ")}

パスワードを変えるときは、ADMIN_PASSWORD_HASH だけを置き直してください(ログイン中の画面はすべてログアウトします)。
`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await run());
}
