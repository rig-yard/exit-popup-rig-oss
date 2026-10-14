/*
  管理画面の API(Hono)。セキュリティ上の想定を設計に取り入れている。

  🔴 **D1・R2 の値に触らない**。データ層の関数へ `c.env`(バインドの入れ物)ごと渡す(境界の検査 = tests/d1-access-boundary)。
  🔴 **認証は既定で拒否**: `/api/admin/*` 全体に掛け、除外は `POST /api/admin/login` の1本だけ。
  🔴 **所有者 id はセッションからしか取らない**。本文・パス・クエリから受け取らない。
  🔴 **他人の id・存在しない id は 404**(作成系の外部キーの断りも 404)。
  🔴 **変更系(GET/HEAD 以外すべて。ログインも含む)は**: ①Origin が自分のオリジンと完全一致 ②`Sec-Fetch-Site` が在れば
    `same-origin` だけ ③Content-Type を明示的に判定(JSON は `application/json`、画像は `application/octet-stream`)。
    同じオリジンの `SameSite=Strict` と合わせて、CSRF トークンは使わない。
  🔴 全応答に `Cache-Control: no-store` と `X-Content-Type-Options: nosniff`。CORS のヘッダは1つも付けない。
*/
import { Hono, type Context } from "hono";
import { IMPLEMENTED_TRIGGERS } from "../../packages/embed/src/bridge";
import { readBytesWithLimit } from "../lib/api/http";
import * as admin from "../lib/data/admin";
import * as auth from "../lib/data/auth";
import * as images from "../lib/data/images";
import { isUuid } from "../lib/data/shapes";
import { MissingBindingError } from "../lib/data/source";
import { logFailure } from "../lib/log/redact";
import { checkImage, IMAGE_TOO_LARGE_MESSAGE, MAX_UPLOAD_BYTES } from "../lib/storage/image";
import {
  parseDeleteConfirm,
  parseEmpty,
  parseFrequency,
  parseLogin,
  parseMobileDesign,
  parseMobileMode,
  parseName,
  parseSite,
  parseThreshold,
  parseTrigger,
  parseVariant,
  type Parsed,
} from "./body";
import { readAdminConfig, type AdminConfig, type AdminEnv } from "./config";
import { expiredSessionCookie, readSessionToken, sessionSetCookie, SESSION_MAX_AGE_SECONDS } from "./cookie";
import {
  connectingAddress,
  constantTimeEqual,
  hmacHex,
  pbkdf2,
  randomBytes,
  sha256Hex,
  toBase64Url,
} from "./crypto";

type Vars = { ownerId: string; config: AdminConfig; tokenHash: string };
type AppEnv = { Bindings: AdminEnv; Variables: Vars };
type Ctx = Context<AppEnv>;

export const API_PREFIX = "/api/admin";
/** 認証を掛けないルート(**この1本だけ**。検査が固定する) */
export const PUBLIC_ROUTES = [`POST ${API_PREFIX}/login`] as const;

const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const JSON_BODY_MAX_BYTES = 16 * 1024;

function now(): Date {
  return new Date();
}

function fail(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503, reason: string, extra: object = {}) {
  return c.json({ ok: false, reason, ...extra }, status);
}

/** データ層の失敗を HTTP に写す。🔴 他人・存在しない・外部キー(作成系)はすべて 404(存在を判別させない)。 */
function fromResult<T>(c: Ctx, result: admin.Result<T>, okStatus: 200 | 201 = 200) {
  if (result.ok) return c.json({ ok: true, data: result.value }, okStatus);
  const f = result.failure;
  switch (f.kind) {
    case "not_found":
    case "foreign_key":
      return fail(c, 404, "not_found");
    case "invalid":
      return fail(c, 400, "invalid", { field: f.field });
    case "limit":
      return fail(c, 409, "limit", { target: f.target });
    case "no_deliverable_variant":
      return fail(c, 409, "no_deliverable_variant");
    case "last_deliverable_variant":
      // 🔴 稼働中のポップから、配信できる最後のパターンを奪う操作
      return fail(c, 409, "last_deliverable_variant", {
        message: "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください",
      });
    case "not_custom":
      // 🔴 スマホの表示設定・デザインを「個別に設定する」にしていないのに、個別の値を書き換えようとした
      return fail(c, 409, "not_custom", { message: "いまは PC と同じ設定です。先にスマホ用に個別に設定してください" });
    case "stale_pc_image":
      // 🔴 「個別に設定する」への複写と書き込みの間に、PC の画像が差し替わっていた(
      //   この case が無いと default に落ちて 500 になる)。再試行(もう一度開いて個別に設定し直す)で直る
      return fail(c, 409, "stale_pc_image", { message: "PC の画像が更新されました。もう一度お試しください" });
    case "unique":
      return fail(c, 409, "conflict");
    case "check":
    case "immutable":
      return fail(c, 400, "invalid");
    case "unknown":
      throw new Error(`unclassified data failure: ${f.detail}`);
    default: {
      // 🔴 網羅チェック: 上のどの case にも当たらない失敗の種類を足し忘れると、
      //   ここで `f` が `never` に絞り込まれず、型エラーでビルドが落ちる(実行時の 500 を待たずに気づける)。
      const exhaustive: never = f;
      throw new Error(`unclassified data failure: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 画像に触る操作の結果。🔴 **R2 から消せずに積んでいる画像があれば、ログに出し、応答にも数を載せる**
 *   (`data.cleanupPending`。黙って 200 を返さない)。積んだキーは次の画像の操作で消し直す。
 */
function withCleanup<T extends images.ImageOutcome>(c: Ctx, where: string, result: admin.Result<T>) {
  if (!result.ok) return fromResult(c, result);
  if (result.value.cleanupPending > 0) {
    logFailure(where, new Error(`images waiting for deletion in storage: ${result.value.cleanupPending}`));
  }
  return c.json({ ok: true, data: { cleanupPending: result.value.cleanupPending } });
}

async function readJson(c: Ctx): Promise<{ value: unknown } | { problem: Response }> {
  const read = await readBytesWithLimit(c.req.raw.body, JSON_BODY_MAX_BYTES);
  if ("problem" in read) return { problem: fail(c, read.problem.status === 413 ? 413 : 400, read.problem.reason) };
  try {
    return { value: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch {
    return { problem: fail(c, 400, "json") };
  }
}

/** 本文を読んで検査する。失敗は 400(どの欄か)。 */
async function body<T>(c: Ctx, parse: (v: unknown) => Parsed<T>): Promise<{ value: T } | { problem: Response }> {
  const json = await readJson(c);
  if ("problem" in json) return json;
  const parsed = parse(json.value);
  if (!parsed.ok) return { problem: fail(c, 400, "invalid", { field: parsed.field }) };
  return { value: parsed.value };
}

function param(c: Ctx, name: string): string | null {
  const value = c.req.param(name);
  return value !== undefined && isUuid(value) ? value : null;
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

function isImageUpload(method: string, path: string): boolean {
  return (
    method === "PUT" &&
    (/^\/api\/admin\/variants\/[^/]+\/image$/.test(path) || /^\/api\/admin\/variants\/[^/]+\/mobile-design\/image$/.test(path))
  );
}

export function createAdminApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ① 全応答のヘッダ。⚠ エラーの応答にも付くよう、後から足す
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  // ② 変更系の守り(CSRF)。GET/HEAD 以外すべて
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return next();
    const origin = c.req.header("origin");
    if (origin === undefined || origin !== new URL(c.req.url).origin) return fail(c, 403, "origin");
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin") return fail(c, 403, "fetch_site");
    const expected = isImageUpload(method, c.req.path) ? "application/octet-stream" : "application/json";
    if (mediaType(c.req.header("content-type")) !== expected) return fail(c, 415, "content_type");
    return next();
  });

  // ③ 設定(秘密)が揃っていなければ全部断る
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const config = readAdminConfig(c.env);
    if (config === null) {
      console.error("[adpop-admin] admin secrets are missing or malformed");
      return fail(c, 503, "config");
    }
    c.set("config", config);
    return next();
  });

  // ④ 認証(既定で拒否・除外はログインの1本だけ)
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if ((PUBLIC_ROUTES as readonly string[]).includes(`${c.req.method.toUpperCase()} ${c.req.path}`)) return next();
    const config = c.get("config");
    const token = readSessionToken(c.req.url, c.req.header("cookie") ?? null);
    if (token === null) return fail(c, 401, "unauthenticated");
    const tokenHash = await sha256Hex(token);
    const session = await auth.findSession(c.env, tokenHash);
    const t = now();
    const fingerprint = (await sha256Hex(config.passwordHashText)).slice(0, 16);
    const valid =
      session !== null &&
      session.expires_at > t.toISOString() &&
      new Date(session.last_seen_at).getTime() + IDLE_TIMEOUT_MS > t.getTime() &&
      // パスワードを変えたら、それより前のセッションは全部無効
      session.password_fingerprint === fingerprint &&
      // 設定の所有者が変わったら、古いセッションは無効
      session.owner_id === config.ownerId;
    if (!valid) {
      if (session !== null) await auth.deleteSession(c.env, tokenHash);
      return fail(c, 401, "unauthenticated");
    }
    if (t.getTime() - new Date(session.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
      await auth.touchSession(c.env, tokenHash, t);
    }
    c.set("ownerId", session.owner_id);
    c.set("tokenHash", tokenHash);
    return next();
  });

  /* ─────────────── 認証 ─────────────── */

  app.post(`${API_PREFIX}/login`, async (c) => {
    const parsed = await body(c, parseLogin);
    if ("problem" in parsed) return parsed.problem;
    const config = c.get("config");
    const t = now();
    // 🔴 接続元の鍵 = 専用の secret で作った「接続元 + 日付」の HMAC(IP を保存しない)
    const day = t.toISOString().slice(0, 10);
    const key = (await hmacHex(config.rateLimitKey, `${connectingAddress(c.req.header("cf-connecting-ip") ?? null)}|${day}`)).slice(0, 32);
    await auth.purgeStaleLoginAttempts(c.env, t);
    await auth.purgeExpiredSessions(c.env, config.ownerId, t, IDLE_TIMEOUT_MS);
    // 🔴 PBKDF2 の前に試行を1つ足す。上限を超えていたらパスワードを確かめない
    const attempts = await auth.reserveLoginAttempt(c.env, key, t);
    if (attempts > auth.LOGIN_ATTEMPTS_PER_WINDOW) return fail(c, 429, "too_many_attempts");
    // 🔴 メールの正否にかかわらず PBKDF2 を1回回す(時間差でメールの正否を分からせない)
    const derived = await pbkdf2(parsed.value.password, config.passwordHash.salt);
    const emailOk = constantTimeEqual(
      new TextEncoder().encode(await sha256Hex(parsed.value.email.trim().toLowerCase())),
      new TextEncoder().encode(await sha256Hex(config.email)),
    );
    const passwordOk = constantTimeEqual(derived, config.passwordHash.hash);
    // ⚠ 失敗のログに本文を出さない。そもそもここではログを出さない
    if (!(emailOk && passwordOk)) return fail(c, 401, "invalid_credentials");

    const ensured = await admin.ensureOwner(c.env, config.ownerId);
    if (!ensured.ok) throw new Error("could not ensure owner");
    await auth.clearLoginAttempts(c.env, key, t);
    const token = toBase64Url(randomBytes(32));
    await auth.createSession(c.env, {
      tokenHash: await sha256Hex(token),
      ownerId: config.ownerId,
      fingerprint: (await sha256Hex(config.passwordHashText)).slice(0, 16),
      expiresAt: new Date(t.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
      now: t,
    });
    c.header("Set-Cookie", sessionSetCookie(c.req.url, token));
    return c.json({ ok: true });
  });

  app.post(`${API_PREFIX}/logout`, async (c) => {
    const parsed = await body(c, parseEmpty);
    if ("problem" in parsed) return parsed.problem;
    await auth.deleteSession(c.env, c.get("tokenHash"));
    c.header("Set-Cookie", expiredSessionCookie(c.req.url));
    return c.json({ ok: true });
  });

  app.get(`${API_PREFIX}/session`, (c) => c.json({ ok: true }));

  /* ─────────────── WORKSPACE(owner 1人につき1。サイトとは別の単位) ─────────────── */

  app.get(`${API_PREFIX}/workspace`, async (c) => fromResult(c, await admin.getWorkspace(c.env, c.get("ownerId"))));

  app.put(`${API_PREFIX}/workspace/name`, async (c) => {
    const parsed = await body(c, parseName);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateWorkspaceName(c.env, c.get("ownerId"), parsed.value.name));
  });

  /* ─────────────── サイト ─────────────── */

  app.get(`${API_PREFIX}/sites`, async (c) => fromResult(c, await admin.listSites(c.env, c.get("ownerId"))));

  app.post(`${API_PREFIX}/sites`, async (c) => {
    const parsed = await body(c, parseSite);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.createSite(c.env, c.get("ownerId"), parsed.value), 201);
  });

  app.get(`${API_PREFIX}/sites/:siteId`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getSite(c.env, c.get("ownerId"), siteId));
  });

  app.put(`${API_PREFIX}/sites/:siteId`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseSite);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateSite(c.env, c.get("ownerId"), siteId, parsed.value));
  });

  app.delete(`${API_PREFIX}/sites/:siteId`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseDeleteConfirm);
    if ("problem" in parsed) return parsed.problem;
    return withCleanup(c, "delete", await images.deleteSiteWithImages(c.env, c.get("ownerId"), siteId));
  });

  /* ─────────────── ポップ ─────────────── */

  app.get(`${API_PREFIX}/sites/:siteId/popups`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    // ⚠ 他人のサイトの id でも「空の一覧」にならないよう、先にサイトを確かめて 404 にする
    const site = await admin.getSite(c.env, c.get("ownerId"), siteId);
    if (!site.ok) return fromResult(c, site);
    return fromResult(c, await admin.listPopups(c.env, c.get("ownerId"), siteId));
  });

  // 🔴 数値(表示・クリック・閉じた)。一覧は `data[popupId].sevenDay`、アーカイブ済み・完全削除の確認は
  //   `data[popupId].lifetime` を読む(一覧とアーカイブ済みそれぞれの選び方)。
  app.get(`${API_PREFIX}/sites/:siteId/popups/stats`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getPopupStats(c.env, c.get("ownerId"), siteId));
  });

  // 🔴 ダッシュボードの推移グラフ。日別・サイト単位の集計。`period` は 7/30/90 のみ
  //   (それ以外・未指定は既定の7に揃える——所有者分離の検査は query 無しで呼ぶため、ここで
  //   400 にすると「別の所有者→404」の検査より先に落ちてしまう。既定値に倒すのはそのため)。
  app.get(`${API_PREFIX}/sites/:siteId/stats/daily`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const raw = c.req.query("period");
    const period = raw === undefined ? 7 : raw === "7" || raw === "30" || raw === "90" ? Number(raw) : null;
    if (period === null) return fail(c, 400, "invalid", { field: "period" });
    return fromResult(c, await admin.getDailySiteStats(c.env, c.get("ownerId"), siteId, period as admin.DailyStatsPeriod));
  });

  /*
    ─────────────── サイトの表示設定(きっかけ・頻度) ───────────────
    🔴 サイト単位(ポップ単位ではない)。PC(desktop)は常に書き込める。mobile は
      `triggers_mode`/`frequency_mode` が `custom` のときだけ。
  */
  function deviceParam(c: Ctx): admin.Device | null {
    const device = c.req.param("device");
    return device === "desktop" || device === "mobile" ? device : null;
  }

  app.get(`${API_PREFIX}/sites/:siteId/display`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getSiteDisplay(c.env, c.get("ownerId"), siteId));
  });

  app.put(`${API_PREFIX}/sites/:siteId/display/:device/frequency`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const device = deviceParam(c);
    if (device === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseFrequency);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateSiteFrequency(c.env, c.get("ownerId"), siteId, device, parsed.value));
  });

  app.put(`${API_PREFIX}/sites/:siteId/display/:device/triggers/:kind`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const device = deviceParam(c);
    if (device === null) return fail(c, 404, "not_found");
    const kind = c.req.param("kind");
    // 🔴 埋め込みが実装しているトリガだけ(画面が ON なのに何も起きない、を作らない)
    if (!(IMPLEMENTED_TRIGGERS as readonly string[]).includes(kind)) return fail(c, 400, "invalid", { field: "kind" });
    const parsed = await body(c, parseTrigger);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(
      c,
      await admin.setSiteTriggerEnabled(c.env, c.get("ownerId"), siteId, device, kind as admin.TriggerKind, parsed.value.enabled),
    );
  });

  // 🔴 閾値。ON/OFF とは別のエンドポイント(frequency / triggers-mode の分け方と同じ)。
  app.put(`${API_PREFIX}/sites/:siteId/display/:device/triggers/:kind/threshold`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const device = deviceParam(c);
    if (device === null) return fail(c, 404, "not_found");
    const kind = c.req.param("kind");
    // 🔴 埋め込みが実装しているトリガだけ(画面が保存できても何も起きない、を作らない)
    if (!(IMPLEMENTED_TRIGGERS as readonly string[]).includes(kind)) return fail(c, 400, "invalid", { field: "kind" });
    const parsed = await body(c, (b: unknown) => parseThreshold(kind as admin.TriggerKind, b));
    if ("problem" in parsed) return parsed.problem;
    return fromResult(
      c,
      await admin.setSiteTriggerThreshold(c.env, c.get("ownerId"), siteId, device, kind as admin.TriggerKind, parsed.value.threshold),
    );
  });

  app.put(`${API_PREFIX}/sites/:siteId/display/triggers-mode`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseMobileMode);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.setSiteTriggersMode(c.env, c.get("ownerId"), siteId, parsed.value.mode));
  });

  app.put(`${API_PREFIX}/sites/:siteId/display/frequency-mode`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseMobileMode);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.setSiteFrequencyMode(c.env, c.get("ownerId"), siteId, parsed.value.mode));
  });

  app.post(`${API_PREFIX}/sites/:siteId/popups`, async (c) => {
    const siteId = param(c, "siteId");
    if (siteId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseName);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.createPopup(c.env, c.get("ownerId"), siteId, parsed.value), 201);
  });

  app.get(`${API_PREFIX}/popups/:popupId`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const ownerId = c.get("ownerId");
    const popup = await admin.getPopup(c.env, ownerId, popupId);
    if (!popup.ok) return fromResult(c, popup);
    const triggers = await admin.listTriggers(c.env, ownerId, popupId);
    const variants = await admin.listVariants(c.env, ownerId, popupId);
    if (!triggers.ok) return fromResult(c, triggers);
    if (!variants.ok) return fromResult(c, variants);
    return c.json({ ok: true, data: { popup: popup.value, triggers: triggers.value, variants: variants.value } });
  });

  app.put(`${API_PREFIX}/popups/:popupId/name`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseName);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.renamePopup(c.env, c.get("ownerId"), popupId, parsed.value.name));
  });

  app.put(`${API_PREFIX}/popups/:popupId/frequency`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseFrequency);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateFrequency(c.env, c.get("ownerId"), popupId, parsed.value));
  });

  app.put(`${API_PREFIX}/popups/:popupId/triggers/:kind`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const kind = c.req.param("kind");
    // 🔴 埋め込みが実装しているトリガだけ(実装していないものを ON にできると、画面は ON なのに何も起きない)
    if (!(IMPLEMENTED_TRIGGERS as readonly string[]).includes(kind)) return fail(c, 400, "invalid", { field: "kind" });
    const parsed = await body(c, parseTrigger);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(
      c,
      await admin.setTriggerEnabled(c.env, c.get("ownerId"), popupId, kind as admin.TriggerKind, parsed.value.enabled),
    );
  });

  for (const [action, run] of [
    ["activate", admin.activatePopup],
    ["pause", admin.pausePopup],
    ["archive", admin.archivePopup],
    ["restore", admin.restorePopup],
  ] as const) {
    app.post(`${API_PREFIX}/popups/:popupId/${action}`, async (c) => {
      const popupId = param(c, "popupId");
      if (popupId === null) return fail(c, 404, "not_found");
      const parsed = await body(c, parseEmpty);
      if ("problem" in parsed) return parsed.problem;
      return fromResult(c, await run(c.env, c.get("ownerId"), popupId));
    });
  }

  app.delete(`${API_PREFIX}/popups/:popupId`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseDeleteConfirm);
    if ("problem" in parsed) return parsed.problem;
    return withCleanup(c, "delete", await images.deletePopupWithImages(c.env, c.get("ownerId"), popupId));
  });

  /* ─────────────── パターン ─────────────── */

  app.post(`${API_PREFIX}/popups/:popupId/variants`, async (c) => {
    const popupId = param(c, "popupId");
    if (popupId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseVariant);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.createVariant(c.env, c.get("ownerId"), popupId, parsed.value), 201);
  });

  app.get(`${API_PREFIX}/variants/:variantId`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getVariant(c.env, c.get("ownerId"), variantId));
  });

  // 🔴 完全削除の確認が
  //   「数字も一緒に消えます」を出すための、パターン1件の累計の表示・クリック・閉じた。
  app.get(`${API_PREFIX}/variants/:variantId/stats`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getVariantStats(c.env, c.get("ownerId"), variantId));
  });

  app.put(`${API_PREFIX}/variants/:variantId`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseVariant);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateVariant(c.env, c.get("ownerId"), variantId, parsed.value));
  });

  for (const [action, run] of [
    ["archive", admin.archiveVariant],
    ["restore", admin.restoreVariant],
  ] as const) {
    app.post(`${API_PREFIX}/variants/:variantId/${action}`, async (c) => {
      const variantId = param(c, "variantId");
      if (variantId === null) return fail(c, 404, "not_found");
      const parsed = await body(c, parseEmpty);
      if ("problem" in parsed) return parsed.problem;
      return fromResult(c, await run(c.env, c.get("ownerId"), variantId));
    });
  }

  app.delete(`${API_PREFIX}/variants/:variantId`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseDeleteConfirm);
    if ("problem" in parsed) return parsed.problem;
    return withCleanup(c, "delete", await images.deleteVariantWithImages(c.env, c.get("ownerId"), variantId));
  });

  /*
    🔴 画像のアップロード: 本文は**画像のバイト列そのもの**(multipart にしない)。
      Content-Type は `application/octet-stream` だけ(②で判定済み)。ストリームを数えながら読み、3MB で打ち切る。
  */
  app.put(`${API_PREFIX}/variants/:variantId/image`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const read = await readBytesWithLimit(c.req.raw.body, MAX_UPLOAD_BYTES);
    if ("problem" in read) return fail(c, read.problem.status === 413 ? 413 : 400, read.problem.reason);
    const checked = checkImage(read.bytes);
    if (!checked.ok) {
      if (checked.reason === "dimensions") return fail(c, 413, "image_dimensions", { message: IMAGE_TOO_LARGE_MESSAGE });
      return fail(c, checked.reason === "size" ? 413 : 415, `image_${checked.reason}`);
    }
    const stored = await images.storeVariantImage(c.env, c.get("ownerId"), variantId, {
      bytes: checked.bytes,
      contentType: checked.type.mime,
      ext: checked.type.ext,
    });
    return withCleanup(c, "image", stored);
  });

  app.delete(`${API_PREFIX}/variants/:variantId/image`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseEmpty);
    if ("problem" in parsed) return parsed.problem;
    return withCleanup(c, "image", await images.removeVariantImage(c.env, c.get("ownerId"), variantId));
  });

  /* ─────────────── スマホのデザイン(パターンの個別の見た目) ─────────────── */

  app.get(`${API_PREFIX}/variants/:variantId/mobile-design`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    return fromResult(c, await admin.getMobileVariantDesign(c.env, c.get("ownerId"), variantId));
  });

  app.put(`${API_PREFIX}/variants/:variantId/mobile-design/mode`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseMobileMode);
    if ("problem" in parsed) return parsed.problem;
    if (parsed.value.mode === "same_as_pc") {
      // 🔴 外れた画像があれば、この要求の中ですぐ R2 から消す(積むだけで終わらせない)。R2 に触るので images.ts 経由。
      //   ほかの画像操作と同じく withCleanup を通す(drain が失敗しても 200 で隠さず、cleanupPending を返す)
      return withCleanup(c, "image", await images.restoreMobileVariantDesignWithImages(c.env, c.get("ownerId"), variantId));
    }
    // 🔴 PC が画像型で画像を持っていれば、R2 上で別のキーに複写してから持つ。R2 に触るので images.ts 経由。
    //   「PC と同じに戻す」側と同じ形(withCleanup)にする——片付けの失敗を cleanupPending で返す
    return withCleanup(c, "image", await images.enterCustomMobileDesign(c.env, c.get("ownerId"), variantId));
  });

  app.put(`${API_PREFIX}/variants/:variantId/mobile-design`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseMobileDesign);
    if ("problem" in parsed) return parsed.problem;
    return fromResult(c, await admin.updateMobileVariantDesign(c.env, c.get("ownerId"), variantId, parsed.value));
  });

  app.put(`${API_PREFIX}/variants/:variantId/mobile-design/image`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const read = await readBytesWithLimit(c.req.raw.body, MAX_UPLOAD_BYTES);
    if ("problem" in read) return fail(c, read.problem.status === 413 ? 413 : 400, read.problem.reason);
    const checked = checkImage(read.bytes);
    if (!checked.ok) {
      if (checked.reason === "dimensions") return fail(c, 413, "image_dimensions", { message: IMAGE_TOO_LARGE_MESSAGE });
      return fail(c, checked.reason === "size" ? 413 : 415, `image_${checked.reason}`);
    }
    const stored = await images.setMobileVariantImage(c.env, c.get("ownerId"), variantId, {
      bytes: checked.bytes,
      contentType: checked.type.mime,
      ext: checked.type.ext,
    });
    return withCleanup(c, "image", stored);
  });

  app.delete(`${API_PREFIX}/variants/:variantId/mobile-design/image`, async (c) => {
    const variantId = param(c, "variantId");
    if (variantId === null) return fail(c, 404, "not_found");
    const parsed = await body(c, parseEmpty);
    if ("problem" in parsed) return parsed.problem;
    return withCleanup(c, "image", await images.removeMobileVariantImage(c.env, c.get("ownerId"), variantId));
  });

  app.notFound((c) => fail(c, 404, "not_found"));

  app.onError((error, c) => {
    if (error instanceof MissingBindingError) {
      logFailure("admin binding", error);
      return fail(c, 503, "config");
    }
    logFailure("admin", error);
    return c.json({ ok: false, reason: "upstream" }, 500);
  });

  return app;
}
