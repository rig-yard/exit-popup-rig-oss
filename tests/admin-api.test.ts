// @vitest-environment node
//
// 管理画面の API(src/admin/app.ts)を、**実物のローカル D1 と R2**(getPlatformProxy)の上で撃つ。
// セキュリティ上の想定を設計に取り入れている。
//
// 🔴 この束が固定するもの:
//   ・CSRF の層を**1枚ずつ独立に**撃つ(Origin / Sec-Fetch-Site / Content-Type)
//   ・ログイン: 生成したパスワードで通る / 試行は PBKDF2 の前に数える(並列でも 5 回まで) / IPv6 は /64
//   ・Cookie の `Set-Cookie` の文字列そのもの
//   ・セッション: パスワード・所有者を変えたら無効 / 期限
//   ・**ルートを実行時に列挙**し、ログイン以外は全部「セッション無し → 401」
//   ・**別の所有者の行を指すと 404 で、相手の行も R2 も変わらない**
//   ・全応答に no-store と nosniff、CORS のヘッダ無し
//   ・画像: octet-stream だけ・3MB で打ち切る・中身で判定・EXIF を落とす
//   ・本文の未知の鍵を断る / `imageKey` を API から書けない
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdminApp, PUBLIC_ROUTES } from "../src/admin/app";
import * as admin from "../src/lib/data/admin";
import * as images from "../src/lib/data/images";
import { handleDelivery } from "../src/delivery/worker";
import { generateSecrets, hashPassword } from "../scripts/admin-hash.mjs";
import { IMAGE_TOO_LARGE_MESSAGE } from "../src/lib/storage/image";
import { openTestD1, type TestD1 } from "./helpers/d1";
import { jpeg, png } from "./helpers/images";
import { r2Snapshot } from "./helpers/r2";

const BASE = "https://adpop-admin.example.workers.dev";
const OTHER_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EMAIL = "owner@example.com";

let t: TestD1;
let secrets: Awaited<ReturnType<typeof generateSecrets>>;
const app = createAdminApp();

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    DB: t.db,
    IMAGES: t.images,
    ADMIN_PASSWORD_HASH: secrets.passwordHash,
    ADMIN_EMAIL: EMAIL,
    ADMIN_OWNER_ID: secrets.ownerId,
    ADMIN_RATE_LIMIT_KEY: secrets.rateLimitKey,
    ...overrides,
  };
}

type Init = { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; cookie?: string; base?: string };

function call(path: string, init: Init = {}, e = env()) {
  const base = init.base ?? BASE;
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.origin = new URL(base).origin;
    headers["content-type"] = init.raw !== undefined ? "application/octet-stream" : "application/json";
  }
  if (init.cookie) headers.cookie = init.cookie;
  Object.assign(headers, init.headers ?? {});
  for (const [k, v] of Object.entries(headers)) if (v === "__omit__") delete headers[k];
  return app.request(
    `${base}${path}`,
    {
      method,
      headers,
      body: init.raw ?? (init.body === undefined ? (method === "GET" || method === "HEAD" ? undefined : "{}") : JSON.stringify(init.body)),
    },
    e,
  );
}

let ipCounter = 0;
/** 試行回数の鍵を検査ごとに分ける(接続元を変える) */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function login(e = env(), ip = freshIp(), base = BASE): Promise<string> {
  const response = await call(
    "/api/admin/login",
    { method: "POST", body: { email: EMAIL, password: secrets.password }, headers: { "cf-connecting-ip": ip }, base },
    e,
  );
  expect(response.status, "ログインに失敗した").toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

/**
 * 🔴 1インストール=1サイト(所有者ごとに1つ)。このファイルは1つの owner を全テストで共有するので、
 * 新しいテスト用のサイトを作る前に、この owner の既存のサイトを消しておく(cascade で配下も消える)。
 */
async function createSite(cookie: string, body: { name: string; allowedOrigins: string[] }) {
  await t.db.prepare("delete from sites where owner_id = ?1").bind(secrets.ownerId).run();
  return call("/api/admin/sites", { method: "POST", body, cookie });
}

beforeAll(async () => {
  t = await openTestD1();
  secrets = await generateSecrets();
});
afterAll(async () => {
  await t?.dispose();
});

describe("秘密の設定(fail closed)", () => {
  it.each([
    ["ハッシュが無い", { ADMIN_PASSWORD_HASH: undefined }],
    ["反復回数が 100000 でない", { ADMIN_PASSWORD_HASH: "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["メールが無い", { ADMIN_EMAIL: undefined }],
    ["所有者 id が UUID でない", { ADMIN_OWNER_ID: "owner" }],
    ["試行回数の鍵が短い", { ADMIN_RATE_LIMIT_KEY: "short" }],
  ])("🔴 %s → ログインも API も 503", async (_label, overrides) => {
    const e = env(overrides);
    const login = await call("/api/admin/login", { method: "POST", body: { email: EMAIL, password: secrets.password } }, e);
    expect(login.status).toBe(503);
    expect((await call("/api/admin/sites", {}, e)).status).toBe(503);
  });
});

describe("CSRF の層(1枚ずつ独立に撃つ)", () => {
  const good = () => ({ method: "POST", body: { email: EMAIL, password: secrets.password }, headers: { "cf-connecting-ip": freshIp() } });
  it("✅ 全部そろえば通る(前提)", async () => {
    expect((await call("/api/admin/login", good())).status).toBe(200);
  });
  it.each([
    ["Origin が無い", { origin: "__omit__" }, 403],
    ["Origin が別のオリジン", { origin: "https://evil.example.com" }, 403],
    ["Origin が null", { origin: "null" }, 403],
    ["Origin が同じホストで http", { origin: BASE.replace("https:", "http:") }, 403],
    ["Sec-Fetch-Site が same-site", { "sec-fetch-site": "same-site" }, 403],
    ["Sec-Fetch-Site が cross-site", { "sec-fetch-site": "cross-site" }, 403],
    ["Content-Type が text/plain(中身は JSON)", { "content-type": "text/plain" }, 415],
    ["Content-Type が multipart/form-data", { "content-type": "multipart/form-data; boundary=x" }, 415],
    ["Content-Type が無い", { "content-type": "__omit__" }, 415],
  ])("🔴 %s → %s(ほかは全部正しい)", async (_label, headers, status) => {
    const init = good();
    const response = await call("/api/admin/login", { ...init, headers: { ...init.headers, ...headers } });
    expect(response.status).toBe(status);
  });
  it("🔴 変更系の判定は GET/HEAD 以外すべて(列挙の外のメソッドも Origin を見る)", async () => {
    const cookie = await login();
    const response = await call("/api/admin/sites", { method: "PATCH", cookie, headers: { origin: "https://evil.example.com" } });
    expect(response.status).toBe(403);
  });
});

describe("ログイン", () => {
  it("🔴 パスワードが違う → 401 / メールが違う → 401(同じ理由)", async () => {
    const wrongPassword = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: "X".repeat(26) },
      headers: { "cf-connecting-ip": freshIp() },
    });
    const wrongEmail = await call("/api/admin/login", {
      method: "POST",
      body: { email: "other@example.com", password: secrets.password },
      headers: { "cf-connecting-ip": freshIp() },
    });
    expect([wrongPassword.status, wrongEmail.status]).toEqual([401, 401]);
    expect(await wrongPassword.json()).toEqual(await wrongEmail.json());
  });

  it("✅ 生成スクリプトのハッシュを、API の照合がそのまま受ける(メールの大文字小文字は問わない)", async () => {
    const response = await call("/api/admin/login", {
      method: "POST",
      body: { email: " Owner@Example.com ", password: secrets.password },
      headers: { "cf-connecting-ip": freshIp() },
    });
    expect(response.status).toBe(200);
  });

  it("🔴 本文の未知の鍵を断る", async () => {
    const response = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: secrets.password, ownerId: OTHER_OWNER },
      headers: { "cf-connecting-ip": freshIp() },
    });
    expect(response.status).toBe(400);
  });

  it("🔴 同じ接続元は 15 分に 5 回まで。6 回目は**正しいパスワードでも** 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      const r = await call("/api/admin/login", { method: "POST", body: { email: EMAIL, password: "wrong" }, headers: { "cf-connecting-ip": ip } });
      expect(r.status).toBe(401);
    }
    const sixth = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: secrets.password },
      headers: { "cf-connecting-ip": ip },
    });
    expect(sixth.status).toBe(429);
  });

  it("🔴🔴 並列に 12 本撃っても、パスワードまで進むのは 5 本まで(試行を PBKDF2 の前に数える)", async () => {
    const ip = freshIp();
    // 🔴 状態コードだけでなく、**PBKDF2 が実際に回った回数**を数える(
    //   上限の判定を PBKDF2 の後ろへ動かしても、状態コードは同じに返せるため)
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        call("/api/admin/login", { method: "POST", body: { email: EMAIL, password: "wrong" }, headers: { "cf-connecting-ip": ip } }),
      ),
    );
    const pbkdf2Calls = derive.mock.calls.filter(([algorithm]) => (algorithm as { name?: string }).name === "PBKDF2").length;
    derive.mockRestore();
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(7);
    expect(pbkdf2Calls, "PBKDF2 が上限を超えて回った").toBe(5);
  });

  it("🔴 IPv6 は /64 に丸める(末尾を変えても同じ数に入る)", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await call("/api/admin/login", {
        method: "POST",
        body: { email: EMAIL, password: "wrong" },
        headers: { "cf-connecting-ip": `2001:db8:1:2::${i}` },
      });
    }
    const sixth = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: secrets.password },
      headers: { "cf-connecting-ip": "2001:db8:1:2:ffff:ffff:ffff:ffff" },
    });
    expect(sixth.status).toBe(429);
  });

  it("🔴 X-Forwarded-For は見ない(毎回変えても同じ数に入る)", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      await call("/api/admin/login", {
        method: "POST",
        body: { email: EMAIL, password: "wrong" },
        headers: { "cf-connecting-ip": ip, "x-forwarded-for": `203.0.113.${i}` },
      });
    }
    const sixth = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: secrets.password },
      headers: { "cf-connecting-ip": ip, "x-forwarded-for": "203.0.113.200" },
    });
    expect(sixth.status).toBe(429);
  });

  it("🔴 ログインを**試みた**だけで、期限切れ・無操作のセッションの行が消える(成功を待たない)", async () => {
    // 所有者の行が無ければ作る(既に在れば owners の BEFORE INSERT が黙って捨てる)
    await t.db.prepare("insert into owners (id) values (?1)").bind(secrets.ownerId).run();
    const old = (hash: string, expires: string) =>
      t.db
        .prepare(
          "insert into admin_sessions (token_hash, owner_id, password_fingerprint, expires_at, last_seen_at) values (?1, ?2, ?3, ?4, '2000-01-01T00:00:00.000Z')",
        )
        .bind(hash, secrets.ownerId, "2".repeat(16), expires);
    // 期限切れ / 期限は先だが 24 時間より前から操作が無い、の2行
    await t.db.batch([old("1".repeat(64), "2000-01-01T00:00:00.000Z"), old("3".repeat(64), "2999-01-01T00:00:00.000Z")]);
    const count = async () =>
      (await t.db.prepare("select count(*) as c from admin_sessions where token_hash in (?1, ?2)").bind("1".repeat(64), "3".repeat(64)).first<{ c: number }>())!.c;
    expect(await count(), "前提: 古いセッションを2行入れた").toBe(2);
    const failed = await call("/api/admin/login", {
      method: "POST",
      body: { email: EMAIL, password: "wrong" },
      headers: { "cf-connecting-ip": freshIp() },
    });
    expect(failed.status).toBe(401);
    expect(await count(), "失敗したログインの試行で掃除されていない").toBe(0);
  });

  it("🔴 試行の表に IP を保存しない(鍵は 32 桁の16進)", async () => {
    const rows = (await t.db.prepare("select key from admin_login_attempts").all<{ key: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).toMatch(/^[0-9a-f]{32}$/);
      expect(row.key).not.toContain("198.51.100");
    }
  });

  it("🔴 失敗したログインで、パスワードもメールもログに出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await call("/api/admin/login", {
      method: "POST",
      body: { email: "leak@example.com", password: "LEAKED-PASSWORD-123" },
      headers: { "cf-connecting-ip": freshIp() },
    });
    // ⚠ 文字列に join すると、オブジェクトで出された値が "[object Object]" になって見えない(変異 B23 で実測)
    const printed = JSON.stringify([...spy.mock.calls, ...log.mock.calls]);
    expect(printed).not.toContain("LEAKED-PASSWORD-123");
    expect(printed).not.toContain("leak@example.com");
    spy.mockRestore();
    log.mockRestore();
  });
});

describe("Cookie(`Set-Cookie` の文字列そのもの)", () => {
  async function setCookieFor(base: string): Promise<string> {
    const response = await call(
      "/api/admin/login",
      { method: "POST", body: { email: EMAIL, password: secrets.password }, headers: { "cf-connecting-ip": freshIp() }, base },
    );
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie") ?? "";
  }
  it("🔴 本番(https)= __Host- + Secure + HttpOnly + SameSite=Strict + Path=/ + 7日", async () => {
    expect(await setCookieFor(BASE)).toMatch(
      /^__Host-adpop_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict$/,
    );
  });
  it("🔴 http でもループバックでなければ __Host- + Secure のまま(設定値では外せない)", async () => {
    expect(await setCookieFor("http://admin.example.com")).toMatch(/^__Host-adpop_session=.*; Secure; SameSite=Strict$/);
  });
  it("✅ http://localhost だけ、接頭辞と Secure を外す", async () => {
    expect(await setCookieFor("http://localhost:8787")).toMatch(
      /^adpop_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Strict$/,
    );
  });
  it("🔴 Cookie の値は DB に保存しない(保存するのは SHA-256)", async () => {
    const cookie = await login();
    const token = cookie.split("=")[1];
    const rows = (await t.db.prepare("select token_hash from admin_sessions").all<{ token_hash: string }>()).results;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });
});

describe("セッション", () => {
  it("✅ ログインしたら /session が 200 / Cookie が無ければ 401", async () => {
    const cookie = await login();
    expect((await call("/api/admin/session", { cookie })).status).toBe(200);
    expect((await call("/api/admin/session")).status).toBe(401);
  });

  it("🔴 パスワード(ハッシュ)を置き直したら、それより前のセッションは無効", async () => {
    const cookie = await login();
    const newHash = await hashPassword("ANOTHERGENERATEDPASSWORD12");
    expect((await call("/api/admin/session", { cookie }, env({ ADMIN_PASSWORD_HASH: newHash }))).status).toBe(401);
  });

  it("🔴 設定の所有者を変えたら、古いセッションは無効", async () => {
    const cookie = await login();
    expect((await call("/api/admin/session", { cookie }, env({ ADMIN_OWNER_ID: OTHER_OWNER }))).status).toBe(401);
  });

  it("🔴 期限切れ・24 時間操作が無いセッションは無効", async () => {
    const cookie = await login();
    await t.db.prepare("update admin_sessions set last_seen_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await call("/api/admin/session", { cookie })).status).toBe(401);
  });

  it("✅ ログアウトでセッションの行が消え、Cookie を期限切れで上書きする", async () => {
    const cookie = await login();
    const out = await call("/api/admin/logout", { method: "POST", body: {}, cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-adpop_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Strict$/);
    expect((await call("/api/admin/session", { cookie })).status).toBe(401);
  });
});

/*
  ══════════════════════════════════════════════════════════════════════════
  ルートの一覧(実行時に列挙して、表と突き合わせる)
  ══════════════════════════════════════════════════════════════════════════
*/
const ROUTES = [
  "POST /api/admin/login",
  "POST /api/admin/logout",
  "GET /api/admin/session",
  "GET /api/admin/workspace",
  "PUT /api/admin/workspace/name",
  "GET /api/admin/sites",
  "POST /api/admin/sites",
  "GET /api/admin/sites/:siteId",
  "PUT /api/admin/sites/:siteId",
  "DELETE /api/admin/sites/:siteId",
  "GET /api/admin/sites/:siteId/popups",
  "GET /api/admin/sites/:siteId/popups/stats",
  "GET /api/admin/sites/:siteId/stats/daily",
  "GET /api/admin/sites/:siteId/display",
  "PUT /api/admin/sites/:siteId/display/:device/frequency",
  "PUT /api/admin/sites/:siteId/display/:device/triggers/:kind",
  "PUT /api/admin/sites/:siteId/display/:device/triggers/:kind/threshold",
  "PUT /api/admin/sites/:siteId/display/triggers-mode",
  "PUT /api/admin/sites/:siteId/display/frequency-mode",
  "POST /api/admin/sites/:siteId/popups",
  "GET /api/admin/popups/:popupId",
  "PUT /api/admin/popups/:popupId/name",
  "PUT /api/admin/popups/:popupId/frequency",
  "PUT /api/admin/popups/:popupId/triggers/:kind",
  "POST /api/admin/popups/:popupId/activate",
  "POST /api/admin/popups/:popupId/pause",
  "POST /api/admin/popups/:popupId/archive",
  "POST /api/admin/popups/:popupId/restore",
  "DELETE /api/admin/popups/:popupId",
  "POST /api/admin/popups/:popupId/variants",
  "GET /api/admin/variants/:variantId",
  "GET /api/admin/variants/:variantId/stats",
  "PUT /api/admin/variants/:variantId",
  "POST /api/admin/variants/:variantId/archive",
  "POST /api/admin/variants/:variantId/restore",
  "DELETE /api/admin/variants/:variantId",
  "PUT /api/admin/variants/:variantId/image",
  "DELETE /api/admin/variants/:variantId/image",
  "GET /api/admin/variants/:variantId/mobile-design",
  "PUT /api/admin/variants/:variantId/mobile-design/mode",
  "PUT /api/admin/variants/:variantId/mobile-design",
  "PUT /api/admin/variants/:variantId/mobile-design/image",
  "DELETE /api/admin/variants/:variantId/mobile-design/image",
];

function listedRoutes(): string[] {
  return app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

/** 別の所有者のデータ(API の利用者 = 設定の所有者 とは違う) */
const other = { site: "", popup: "", variant: "" };
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);

function bodyFor(route: string): Init {
  const [method, path] = route.split(" ");
  if (path.endsWith("/image") && method === "PUT") return { method, raw: TINY_PNG };
  if (method === "DELETE" && !path.endsWith("/image")) return { method, body: { confirm: "delete" } };
  if (route === "POST /api/admin/sites" || route === "PUT /api/admin/sites/:siteId") {
    return { method, body: { name: "x", allowedOrigins: [] } };
  }
  if (path.endsWith("/popups") && method === "POST") return { method, body: { name: "x" } };
  if (path.endsWith("/name")) return { method, body: { name: "x" } };
  if (path.endsWith("/frequency")) {
    return { method, body: { suppressDays: 0, sessionImpressions: 9, postConversionDays: 0, minDisplayDelaySeconds: 0 } };
  }
  // 🔴 `concrete()` は :kind を "exit_intent" に固定する。exit_intent は閾値を持たないので null しか通らない。
  if (path.endsWith("/threshold")) return { method, body: { threshold: null } };
  if (path.includes("/triggers/") || path.includes("/mobile-triggers/")) return { method, body: { enabled: false } };
  if (path.endsWith("/triggers-mode") || path.endsWith("/frequency-mode") || path.endsWith("/mobile-design/mode")) {
    return { method, body: { mode: "custom" } };
  }
  if (path.endsWith("/mobile-design") && method === "PUT") {
    return { method, body: { kind: "text", content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" } } };
  }
  if (path.endsWith("/variants") && method === "POST" || route === "PUT /api/admin/variants/:variantId") {
    return { method, body: { kind: "text", content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" }, destinationUrl: "https://evil.example.com/" } };
  }
  return { method, body: method === "GET" ? undefined : {} };
}

function concrete(path: string): string {
  return path
    .replace(":siteId", other.site)
    .replace(":popupId", other.popup)
    .replace(":variantId", other.variant)
    .replace(":device", "desktop")
    .replace(":kind", "exit_intent");
}

describe("ルートと所有者の分離", () => {
  beforeAll(async () => {
    const e = { DB: t.db, IMAGES: t.images };
    await admin.ensureOwner(e, OTHER_OWNER);
    const site = await admin.createSite(e, OTHER_OWNER, { name: "他人", allowedOrigins: ["https://other.example.com"] });
    if (!site.ok) throw new Error("準備に失敗");
    other.site = site.value.id;
    const popup = await admin.createPopup(e, OTHER_OWNER, other.site, { name: "他人" });
    if (!popup.ok) throw new Error("準備に失敗");
    other.popup = popup.value.id;
    const variant = await admin.createVariant(e, OTHER_OWNER, other.popup, {
      kind: "text",
      content: { headline: "他人", body: "", buttonLabel: "", imageAlt: "" },
      destinationUrl: "https://offer.example.com/",
    });
    if (!variant.ok) throw new Error("準備に失敗");
    other.variant = variant.value.id;
    const stored = await images.storeVariantImage(e, OTHER_OWNER, other.variant, { bytes: TINY_PNG, contentType: "image/png", ext: "png" });
    if (!stored.ok) throw new Error("準備に失敗");
  });

  it("🔴 アプリのルートが、上の表ちょうど(足し忘れると落ちる)", () => {
    expect(listedRoutes()).toEqual([...ROUTES].sort());
  });

  it("🔴 認証を掛けないのはログインの1本だけ", () => {
    expect([...PUBLIC_ROUTES]).toEqual(["POST /api/admin/login"]);
  });

  it("🔴 ログイン以外の全ルートは、セッション無しで 401(既定で拒否)", async () => {
    for (const route of ROUTES.filter((r) => !(PUBLIC_ROUTES as readonly string[]).includes(r))) {
      const [, path] = route.split(" ");
      const response = await call(concrete(path), bodyFor(route));
      expect(response.status, route).toBe(401);
    }
  });

  it("🔴🔴 別の所有者の行を指すと、全ルートが 404。相手の行も R2 の中身も変わらない", async () => {
    const cookie = await login();
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      for (const table of [
        "sites",
        "site_allowed_origins",
        "popups",
        "popup_triggers",
        "variants",
        "events",
        "site_display_settings",
        "site_display_triggers",
      ]) {
        out[table] = (await t.db.prepare(`select * from ${table} where owner_id = ?1 order by rowid`).bind(OTHER_OWNER).all()).results;
      }
      // 🔴 キーだけでなく本文のバイト列と Content-Type も比べる
      out.r2 = await r2Snapshot(t.images);
      return out;
    };
    const before = await snapshot();
    expect(before.r2.length, "相手の画像が無い = R2 を測っていない").toBe(1);
    const withIds = ROUTES.filter((r) => r.includes(":"));
    expect(withIds.length).toBeGreaterThan(15);
    for (const route of withIds) {
      const [, path] = route.split(" ");
      const response = await call(concrete(path), { ...bodyFor(route), cookie });
      expect(response.status, route).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("🔴 一覧には別の所有者の行が出ない", async () => {
    const cookie = await login();
    const response = await call("/api/admin/sites", { cookie });
    expect(JSON.stringify(await response.json())).not.toContain(other.site);
  });
});

describe("ヘッダ", () => {
  it("🔴 成功・401・403・404・415 のどれにも no-store と nosniff。CORS のヘッダは付けない", async () => {
    const cookie = await login();
    const responses = [
      await call("/api/admin/sites", { cookie }),
      await call("/api/admin/sites"),
      await call("/api/admin/sites", { method: "POST", body: { name: "x", allowedOrigins: [] }, cookie, headers: { origin: "https://evil.example.com" } }),
      await call("/api/admin/nothing", { cookie }),
      await call("/api/admin/sites", { method: "POST", body: {}, cookie, headers: { "content-type": "text/plain" } }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 403, 404, 415]);
    for (const r of responses) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect([...r.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("1インストール=1サイト(所有者ごとに1つ)", () => {
  it("🔴 2つ目のサイトの作成は API を直接叩いても 409(理由は既存の上限超過と同じ limit/sites)。1つ目は1行も変わらない", async () => {
    const cookie = await login();
    const first = await createSite(cookie, { name: "1つ目", allowedOrigins: [] });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { data: { id: string } }).data.id;

    // 🔴 `createSite`(テストヘルパー)は前のサイトを消してから作るので、ここは直接 call() で
    //   「1つ目を残したまま2つ目を作ろうとする」を撃つ(ヘルパーを使うと前提が崩れる)。
    const second = await call("/api/admin/sites", { method: "POST", body: { name: "2つ目", allowedOrigins: [] }, cookie });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: "limit", target: "sites" });

    const list = (await (await call("/api/admin/sites", { cookie })).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((s) => s.id)).toEqual([firstId]);
  });
});

describe("サイト・ポップ・パターンの API(通る側)", () => {
  it("✅ 作る → 一覧 → 稼働 → 配信の設定に載る", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "API", allowedOrigins: ["https://lp.example.com"] });
    expect(site.status).toBe(201);
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "text", content: { headline: "見出し", body: "", buttonLabel: "", imageAlt: "" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    expect(variant.status).toBe(201);
    expect((await call(`/api/admin/popups/${popupId}/activate`, { method: "POST", body: {}, cookie })).status).toBe(200);
    const detail = (await (await call(`/api/admin/popups/${popupId}`, { cookie })).json()) as { data: { popup: { status: string } } };
    expect(detail.data.popup.status).toBe("active");
  });

  it("🔴 実装していないトリガは ON にできない(画面が ON なのに何も起きない、を作らない)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "t", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    // 🔴 後の改訂で scroll/dwell は実装側に移った(IMPLEMENTED_TRIGGERS)。未実装のままなのは idle/back/visibility。
    expect((await call(`/api/admin/popups/${popupId}/triggers/idle`, { method: "PUT", body: { enabled: true }, cookie })).status).toBe(400);
    expect((await call(`/api/admin/popups/${popupId}/triggers/exit_intent`, { method: "PUT", body: { enabled: false }, cookie })).status).toBe(200);
  });

  it("🔴 トリガの閾値は kind ごとの範囲で断る", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "threshold", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const put = (kind: string, threshold: unknown) =>
      call(`/api/admin/sites/${siteId}/display/desktop/triggers/${kind}/threshold`, { method: "PUT", body: { threshold }, cookie });

    // scroll(到達率%)は 1〜100。範囲外・小数・文字列はすべて断る
    expect((await put("scroll", 0)).status).toBe(400);
    expect((await put("scroll", 101)).status).toBe(400);
    expect((await put("scroll", 50.5)).status).toBe(400);
    expect((await put("scroll", "50")).status).toBe(400);
    expect((await put("scroll", 50)).status).toBe(200);
    expect((await put("scroll", null)).status).toBe(200); // null = 既定値を使う

    // dwell(秒)は 1〜3600
    expect((await put("dwell", 0)).status).toBe(400);
    expect((await put("dwell", 3601)).status).toBe(400);
    expect((await put("dwell", 45)).status).toBe(200);

    // 閾値を持たないトリガ(exit_intent)は null しか受け付けない
    expect((await put("exit_intent", 10)).status).toBe(400);
    expect((await put("exit_intent", null)).status).toBe(200);

    const detail = (await (await call(`/api/admin/sites/${siteId}/display`, { cookie })).json()) as {
      data: { desktop: { triggers: Array<{ kind: string; threshold: number | null }> } };
    };
    expect(detail.data.desktop.triggers.find((t) => t.kind === "scroll")?.threshold).toBeNull();
    expect(detail.data.desktop.triggers.find((t) => t.kind === "dwell")?.threshold).toBe(45);
  });

  it("🔴 パターンの本文に imageKey を混ぜると 400(API から画像のキーを書けない)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "m6", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const response = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: {
        kind: "text",
        content: { headline: "x", body: "", buttonLabel: "", imageAlt: "", imageKey: `images/${"a".repeat(32)}.png` },
        destinationUrl: "https://offer.example.com/",
      },
      cookie,
    });
    expect(response.status).toBe(400);
  });

  it("🔴 画像型・ボタン文言が空のときは画像の説明(imageAlt)が無いと 400", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "alt", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const body = (imageAlt: string) => ({
      kind: "image",
      content: { headline: "", body: "", buttonLabel: "", imageAlt },
      destinationUrl: "https://offer.example.com/",
    });
    const rejected = await call(`/api/admin/popups/${popupId}/variants`, { method: "POST", body: body(""), cookie });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, reason: "invalid", field: "imageAlt" });

    const accepted = await call(`/api/admin/popups/${popupId}/variants`, { method: "POST", body: body("商品の写真"), cookie });
    expect(accepted.status).toBe(201);
  });

  it("✅ ボタン文言があれば画像の説明が空でも通る(必須なのはどちらか1つ)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "alt2", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const response = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "友だち追加", imageAlt: "" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    expect(response.status).toBe(201);
  });

  it("⚠ text 型は imageAlt が空でも通る(必須なのは画像型だけ)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "alt3", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const response = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "text", content: { headline: "", body: "", buttonLabel: "", imageAlt: "" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    expect(response.status).toBe(201);
  });
});

describe("稼働中のポップから最後の配信可能パターンを奪う操作は 409", () => {
  it("🔴 唯一のパターンのアーカイブは 409・文言つき。削除・編集(画像の無い画像型へ)も同様", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "floor", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "text", content: { headline: "唯一", body: "", buttonLabel: "", imageAlt: "" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    const variantId = ((await variant.json()) as { data: { id: string } }).data.id;
    expect((await call(`/api/admin/popups/${popupId}/activate`, { method: "POST", body: {}, cookie })).status).toBe(200);

    const archived = await call(`/api/admin/variants/${variantId}/archive`, { method: "POST", body: {}, cookie });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toEqual({
      ok: false,
      reason: "last_deliverable_variant",
      message: "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください",
    });

    const edited = await call(`/api/admin/variants/${variantId}`, {
      method: "PUT",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    expect(edited.status).toBe(409);

    const deleted = await call(`/api/admin/variants/${variantId}`, { method: "DELETE", body: { confirm: "delete" }, cookie });
    expect(deleted.status).toBe(409);

    // ⚠ どれも断られたので、パターンはまだ存在しテキスト型のまま
    const still = await call(`/api/admin/variants/${variantId}`, { cookie });
    expect(still.status).toBe(200);
    expect(((await still.json()) as { data: { kind: string } }).data.kind).toBe("text");
  });
});

describe("画像のアップロード", () => {
  let cookie = "";
  let variantId = "";
  beforeAll(async () => {
    cookie = await login();
    const site = await createSite(cookie, { name: "img", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "画像の説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    variantId = ((await variant.json()) as { data: { id: string } }).data.id;
  });

  const upload = (raw: BodyInit, headers: Record<string, string> = {}) =>
    call(`/api/admin/variants/${variantId}/image`, { method: "PUT", raw, cookie, headers });

  it("🔴 multipart は 415(単純でない application/octet-stream だけ)", async () => {
    expect((await upload(TINY_PNG, { "content-type": "multipart/form-data; boundary=x" })).status).toBe(415);
    expect((await upload(TINY_PNG, { "content-type": "image/png" })).status).toBe(415);
  });

  it("🔴 3MB を超えたら 413 / GIF でない 2MB 超えも 413", async () => {
    const huge = new Uint8Array(3 * 1024 * 1024 + 1);
    huge.set(TINY_PNG.subarray(0, 8));
    expect((await upload(huge)).status).toBe(413);
    const bigPng = new Uint8Array(2 * 1024 * 1024 + 1);
    bigPng.set(TINY_PNG.subarray(0, 8));
    expect((await upload(bigPng)).status).toBe(413);
  });

  it("🔴 中身が画像でないもの(SVG・HTML)は 415", async () => {
    expect((await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status).toBe(415);
    expect((await upload(new TextEncoder().encode("<html></html>"))).status).toBe(415);
  });

  it("✅ PNG は置かれ、配信の Worker の /img から同じバイト列で返る", async () => {
    expect((await upload(TINY_PNG)).status).toBe(200);
    const variant = (await (await call(`/api/admin/variants/${variantId}`, { cookie })).json()) as {
      data: { content: { imageKey: string } };
    };
    const key = variant.data.content.imageKey;
    expect(key).toMatch(/^images\/[0-9a-f]{32}\.png$/);
    const served = await handleDelivery(new Request(`https://delivery.example.com/img/${key.slice("images/".length)}`), {
      DB: t.db,
      IMAGES: t.images,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(TINY_PNG);
  });

  it("🔴 差し替えると前の画像は R2 から消える / パターンを消すと画像も消える", async () => {
    const before = (await t.images.list()).objects.map((o) => o.key);
    expect((await upload(TINY_PNG)).status).toBe(200);
    const after = (await t.images.list()).objects.map((o) => o.key);
    expect(after.length).toBe(before.length);
    expect((await call(`/api/admin/variants/${variantId}`, { method: "DELETE", body: { confirm: "delete" }, cookie })).status).toBe(200);
    expect((await t.images.list()).objects.length).toBe(before.length - 1);
  });

  it("🔴 JPEG の Exif(APP1)は落としてから置く", async () => {
    const site = await createSite(cookie, { name: "jpeg", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "画像の説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    const id = ((await variant.json()) as { data: { id: string } }).data.id;
    // SOI + APP1(Exif・"GPS" を含む)+ SOF0 + SOS + データ + EOI
    const exif = [0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x21];
    const response = await call(`/api/admin/variants/${id}/image`, { method: "PUT", raw: jpeg(16, 16, exif) as BodyInit, cookie });
    expect(response.status).toBe(200);
    const detail = (await (await call(`/api/admin/variants/${id}`, { cookie })).json()) as { data: { content: { imageKey: string } } };
    const stored = await t.images.get(detail.data.content.imageKey);
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(jpeg(16, 16)));
  });

  it("🔴 長い辺が 2,400px を超える画像は 413 と文言", async () => {
    const site = await createSite(cookie, { name: "dims", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "画像の説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    const id = ((await variant.json()) as { data: { id: string } }).data.id;
    const put = (raw: Uint8Array) => call(`/api/admin/variants/${id}/image`, { method: "PUT", raw: raw as BodyInit, cookie });
    const response = await put(png(2401, 100));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, reason: "image_dimensions", message: IMAGE_TOO_LARGE_MESSAGE });
    expect((await put(png(100, 2400))).status).toBe(200);
  });
});

describe("R2 から消せなかった画像", () => {
  it("🔴 画像を外すときに R2 から消せなければ、応答に数が載り(黙って 200 にしない)、ログに出て、次の操作で消し直す", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "cleanup", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "画像の説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    const id = ((await variant.json()) as { data: { id: string } }).data.id;
    expect((await call(`/api/admin/variants/${id}/image`, { method: "PUT", raw: png(10, 10) as BodyInit, cookie })).status).toBe(200);
    const key = ((await (await call(`/api/admin/variants/${id}`, { cookie })).json()) as { data: { content: { imageKey: string } } }).data.content.imageKey;

    // R2 の delete だけが落ちる環境
    const failingImages = new Proxy(t.images, {
      get(target, prop) {
        if (prop === "delete") return () => Promise.reject(new Error("R2 unavailable"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const removed = await call(`/api/admin/variants/${id}/image`, { method: "DELETE", body: {}, cookie }, { ...env(), IMAGES: failingImages });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, data: { cleanupPending: 1 } });
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(key.slice(7, 39));
    errors.mockRestore();
    expect(await t.images.head(key), "前提: 消せずに残っている").not.toBeNull();

    // 積んでから時間が経つと(置いている途中のアップロードを消さないための待ち)、次の画像の操作で消し直す
    await t.db.prepare("update pending_image_deletions set created_at = '2000-01-01T00:00:00.000Z' where key = ?1").bind(key).run();
    expect((await call(`/api/admin/variants/${id}/image`, { method: "PUT", raw: png(10, 10) as BodyInit, cookie })).status).toBe(200);
    expect(await t.images.head(key), "消し直されていない").toBeNull();
    const pending = await t.db.prepare("select count(*) as c from pending_image_deletions where key = ?1").bind(key).first<{ c: number }>();
    expect(pending?.c).toBe(0);
  });
});

describe("スマホのデザイン: PC の画像が複写の途中で差し替わる競合", () => {
  it("🔴🔴 複写と書き込みの間に PC の画像が差し替わると、ルートは 409(stale_pc_image)を返し、複写した新しいキーは片付く", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "race", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;
    const variant = await call(`/api/admin/popups/${popupId}/variants`, {
      method: "POST",
      body: { kind: "image", content: { headline: "", body: "", buttonLabel: "", imageAlt: "画像の説明" }, destinationUrl: "https://offer.example.com/" },
      cookie,
    });
    const variantId = ((await variant.json()) as { data: { id: string } }).data.id;
    expect((await call(`/api/admin/variants/${variantId}/image`, { method: "PUT", raw: png(10, 10) as BodyInit, cookie })).status).toBe(200);

    // PC の画像を B へ差し替える先(実体)を R2 に用意しておく(生 SQL で向け替えるときに使う)
    const pcKeyB = `images/${"b".repeat(32)}.png`;
    await t.images.put(pcKeyB, png(11, 11), { httpMetadata: { contentType: "image/png" } });
    const keysBefore = new Set((await r2Snapshot(t.images)).map((e) => e.key));
    const pendingBefore = new Set(
      (await t.db.prepare(`select key from pending_image_deletions`).all<{ key: string }>()).results.map((r) => r.key),
    );

    // R2 の `get`(= PC の画像を読んで複写を始める、まさにその瞬間)を横取りして、
    //   「複写の最中に PC の画像が差し替わる」をルート越しに再現する
    const racyImages = new Proxy(t.images, {
      get(target, prop) {
        if (prop === "get") {
          return async (key: string) => {
            await t.db.prepare(`update variants set content = json_set(content, '$.imageKey', ?2) where id = ?1`).bind(variantId, pcKeyB).run();
            return (Reflect.get(target, prop) as (k: string) => unknown).apply(target, [key]);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const response = await call(`/api/admin/variants/${variantId}/mobile-design/mode`, { method: "PUT", body: { mode: "custom" }, cookie }, { ...env(), IMAGES: racyImages });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: "stale_pc_image" });

    // スマホのデザインは same_as_pc のまま(書き換わっていない)
    const design = await (await call(`/api/admin/variants/${variantId}/mobile-design`, { cookie })).json();
    expect(design).toMatchObject({ ok: true, data: { mode: "same_as_pc" } });

    // 複写した新しいキーは、台帳に積まれたままにせず R2 からも消えている
    //   (基準点〔B を置いた直後〕から新しく増えた R2 のキー・台帳の行が無いこと=複写した新しいキーが残っていない)
    const keysAfter = new Set((await r2Snapshot(t.images)).map((e) => e.key));
    expect(keysAfter.has(pcKeyB)).toBe(true); // B 自体は(わざと置いたので)残っている
    expect([...keysAfter].filter((k) => !keysBefore.has(k))).toEqual([]);
    const pendingAfter = (await t.db.prepare(`select key from pending_image_deletions`).all<{ key: string }>()).results.map((r) => r.key);
    expect(pendingAfter.filter((k) => !pendingBefore.has(k))).toEqual([]);
  });
});

describe("数値(表示・クリック・閉じた)", () => {
  it("✅ イベントが1件も無いポップは 200 で、数字が0であること(0件と取得失敗を区別する前提)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "stats-empty", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const popup = await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });
    const popupId = ((await popup.json()) as { data: { id: string } }).data.id;

    const response = await call(`/api/admin/sites/${siteId}/popups/stats`, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        [popupId]: {
          sevenDay: { impression: 0, click: 0, close: 0 },
          lifetime: { impression: 0, click: 0, close: 0 },
        },
      },
    });
  });

  it("🔴 DBの問い合わせ自体(batch)が失敗したら 500(ok:false, reason:upstream)。0件(上のテスト)とは別のコード", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "stats-fail", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    // ⚠ popupIds.length === 0 のときは batch() 自体を呼ばず早期に ok({}) を返す実装なので、
    //   batch() が実際に呼ばれる(= 失敗しうる)状況にするため、ポップを最低1つ作る
    await call(`/api/admin/sites/${siteId}/popups`, { method: "POST", body: { name: "p" }, cookie });

    // DB の prepare/all/batch だけが落ちる環境(バインド自体は正常に存在する)
    const failingDb = new Proxy(t.db, {
      get(target, prop) {
        if (prop === "batch") return () => Promise.reject(new Error("D1 unavailable"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(`/api/admin/sites/${siteId}/popups/stats`, { cookie }, { ...env(), DB: failingDb as unknown as typeof t.db });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, reason: "upstream" });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("🔴 DBバインドが丸ごと無いのは別の経路(設定の不備・MissingBindingError)で 503。500(上のテスト)と取り違えない", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "stats-noconfig", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // ⚠ DB が無いと、この手前のセッション検査(auth.findSession)が先に MissingBindingError で落ちる
    const response = await call(`/api/admin/sites/${siteId}/popups/stats`, { cookie }, env({ DB: undefined }));
    expect(response.status).toBe(503);
    errors.mockRestore();
  });
});

describe("日別の集計(ダッシュボードの推移グラフ)", () => {
  it("✅ イベントが1件も無いサイトでも 200 で、期間ぶんの日が 0 件で埋まる(0件と取得失敗を区別する前提)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "daily-empty", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;

    const response = await call(`/api/admin/sites/${siteId}/stats/daily?period=7`, { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: Array<{ date: string; impression: number; click: number; close: number }> };
    expect(body.data).toHaveLength(7);
    for (const point of body.data) expect(point).toMatchObject({ impression: 0, click: 0, close: 0 });
    // 🔴 日付が重複せず、1日ずつ連続していること(穴あき・重複の両方を見る)
    expect(new Set(body.data.map((p) => p.date)).size).toBe(7);
  });

  it("✅ period は 7/30/90 だけ。省略は既定の7(他人の所有者→404の検査が query 無しで呼ぶため)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "daily-period", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;

    const noQuery = await call(`/api/admin/sites/${siteId}/stats/daily`, { cookie });
    expect(noQuery.status).toBe(200);
    expect(((await noQuery.json()) as { data: unknown[] }).data).toHaveLength(7);

    const thirty = await call(`/api/admin/sites/${siteId}/stats/daily?period=30`, { cookie });
    expect(((await thirty.json()) as { data: unknown[] }).data).toHaveLength(30);

    const invalid = await call(`/api/admin/sites/${siteId}/stats/daily?period=8`, { cookie });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, reason: "invalid", field: "period" });
  });

  it("🔴 DBの問い合わせ自体が失敗したら 500(ok:false, reason:upstream)。0件とは別のコード", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "daily-fail", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;

    function makeFailing(stmt: ReturnType<typeof t.db.prepare>): ReturnType<typeof t.db.prepare> {
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === "all") return () => Promise.reject(new Error("D1 unavailable"));
          if (prop === "bind") {
            return (...args: unknown[]) => makeFailing((target.bind as (...a: unknown[]) => typeof stmt)(...args));
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const failingDb = new Proxy(t.db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => makeFailing((target.prepare as (s: string) => ReturnType<typeof t.db.prepare>)(sql));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(`/api/admin/sites/${siteId}/stats/daily`, { cookie }, { ...env(), DB: failingDb as unknown as typeof t.db });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, reason: "upstream" });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("🔴 DBバインドが丸ごと無いのは 503(500とは別経路)", async () => {
    const cookie = await login();
    const site = await createSite(cookie, { name: "daily-noconfig", allowedOrigins: [] });
    const siteId = ((await site.json()) as { data: { id: string } }).data.id;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(`/api/admin/sites/${siteId}/stats/daily`, { cookie }, env({ DB: undefined }));
    expect(response.status).toBe(503);
    errors.mockRestore();
  });
});
