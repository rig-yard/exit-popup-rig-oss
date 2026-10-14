// @vitest-environment node
//
// サイト単位の表示設定(きっかけ・頻度)。
// 🔴 ここは**状態**を測る:
//   ① 既存データの引き継ぎの優先順(稼働中 → 無ければ最終更新の非アーカイブ → 無ければ既定値)が
//      SQL で正しく効いているかを、**0005 を当てる前に生 SQL で「移行前の状態」を作ってから当てる**形で確かめる
//      (`openTestD1` は毎回 0001〜最新までを通しで当てるので、既存データの引き継ぎそのものは
//      この専用のワークスペースでしか再現できない)。
//   ② 付け替えたポップ単位の API(`updateFrequency` / `setTriggerEnabled` / `listTriggers` / `getPopup`)が、
//      `popups` / `popup_triggers`(凍結)ではなくサイトの `site_display_settings` / `site_display_triggers`
//      を読み書きしていることを、**凍結した表を直接書き換えても出力が変わらない**ことで確かめる。
//   ③ サイト単位のモード切替(desktop は常に書ける・mobile は custom のときだけ)。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import * as admin from "../src/lib/data/admin";
import { errorOf, openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "db/migrations");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const BEFORE_0005 = FILES.filter((f) => f < "0005");
const AFTER_0005 = FILES.filter((f) => f >= "0005");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** 0001〜0004 だけを当てたワークスペース(「0005 を当てる前」を再現する)を作る。 */
function workspace(): { dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-s1-mig-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "m"));
  writeFileSync(path.join(dir, "w.js"), 'export default { fetch() { return new Response("") } }');
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "s1-check",
      main: "w.js",
      compatibility_date: "2026-09-30",
      d1_databases: [{ binding: "DB", database_name: "s1check", database_id: "00000000-0000-4000-8000-0000000000bb", migrations_dir: "m" }],
    }),
  );
  for (const file of BEFORE_0005) cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file));
  apply(dir);
  return { dir };
}

function apply(dir: string): void {
  execFileSync(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "s1check", "--local", "--persist-to", path.join(dir, "p"), "-c", path.join(dir, "wrangler.jsonc")],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
}

function applyRemaining0005(dir: string): void {
  for (const file of AFTER_0005) cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file));
  apply(dir);
}

async function openDb(dir: string): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(dir, "wrangler.jsonc"),
    persist: { path: path.join(dir, "p", "v3") },
  });
  return { db: proxy.env.DB, dispose: () => proxy.dispose() };
}

describe("既存データの引き継ぎ(0005 を当てる前の状態から)", () => {
  let dir: string;
  let db: D1Database;
  let dispose: () => Promise<void>;
  // サイトごとの id(引き継ぎ元の状態が違う4つ)
  const siteActive = crypto.randomUUID();
  const siteStale = crypto.randomUUID();
  const siteEmpty = crypto.randomUUID();
  const siteNullThreshold = crypto.randomUUID();
  const popupActive = crypto.randomUUID();
  const popupStaleOld = crypto.randomUUID();
  const popupStaleNew = crypto.randomUUID();
  const popupStaleArchived = crypto.randomUUID();
  const popupNullThreshold = crypto.randomUUID();

  beforeAll(async () => {
    const ws = workspace();
    dir = ws.dir;
    const opened = await openDb(dir);
    db = opened.db;
    dispose = opened.dispose;

    value(await admin.ensureOwner(db, OWNER_A));

    // ── サイト1: 稼働中のポップがある ──────────────────────────────────
    await db
      .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'active site', ?3)`)
      .bind(siteActive, OWNER_A, "a".repeat(32))
      .run();
    await db
      .prepare(
        `insert into popups (id, owner_id, site_id, public_key, name, status,
           suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
         values (?1, ?2, ?3, ?4, 'active popup', 'active', 9, 2, 14, 5)`,
      )
      .bind(popupActive, OWNER_A, siteActive, "b".repeat(32))
      .run();
    // 0001 の after-insert トリガが popup_triggers の6行を既定値で揃えている。scroll だけ上書きする
    await db
      .prepare(`update popup_triggers set enabled = 1, threshold = 77 where popup_id = ?1 and kind = 'scroll'`)
      .bind(popupActive)
      .run();
    // 0004 の after-insert トリガが popup_mobile_display/triggers を揃えている。custom にして PC と違う値にする
    await db
      .prepare(
        `update popup_mobile_display set triggers_mode = 'custom', frequency_mode = 'custom',
           suppress_days = 3, session_impressions = 1, post_conversion_days = 1, min_display_delay_seconds = 1
         where popup_id = ?1`,
      )
      .bind(popupActive)
      .run();
    await db
      .prepare(`update popup_mobile_triggers set enabled = 1, threshold = 33 where popup_id = ?1 and kind = 'scroll'`)
      .bind(popupActive)
      .run();

    // ── サイト2: 稼働中は無いが、非アーカイブのポップが2つ(新しい方を使う)+ アーカイブ済みが1つ ──
    await db
      .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'stale site', ?3)`)
      .bind(siteStale, OWNER_A, "c".repeat(32))
      .run();
    await db
      .prepare(
        `insert into popups (id, owner_id, site_id, public_key, name, status, updated_at,
           suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
         values (?1, ?2, ?3, ?4, 'old', 'paused', '2026-01-01T00:00:00.000Z', 1, 1, 1, 1)`,
      )
      .bind(popupStaleOld, OWNER_A, siteStale, "d".repeat(32))
      .run();
    await db
      .prepare(
        `insert into popups (id, owner_id, site_id, public_key, name, status, updated_at,
           suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
         values (?1, ?2, ?3, ?4, 'new', 'paused', '2026-06-01T00:00:00.000Z', 21, 3, 40, 9)`,
      )
      .bind(popupStaleNew, OWNER_A, siteStale, "e".repeat(32))
      .run();
    await db
      .prepare(`update popup_triggers set enabled = 1, threshold = 60 where popup_id = ?1 and kind = 'dwell'`)
      .bind(popupStaleNew)
      .run();
    // アーカイブ済み(かつ updated_at が一番新しい)。出どころに選ばれてはいけない
    await db
      .prepare(
        `insert into popups (id, owner_id, site_id, public_key, name, status, archived_at, updated_at,
           suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
         values (?1, ?2, ?3, ?4, 'archived', 'paused', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 999, 1, 1, 1)`,
      )
      .bind(popupStaleArchived, OWNER_A, siteStale, "f".repeat(32))
      .run();

    // ── サイト3: ポップが1つも無い ──────────────────────────────────
    await db
      .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, '空のサイト', ?3)`)
      .bind(siteEmpty, OWNER_A, "0".repeat(32))
      .run();

    // ── サイト4: 稼働中のポップの scroll トリガが「行はあるが threshold は NULL」(enabled のみ true) ──
    //   🔴 coalesce(pt.threshold, k.def_threshold) は「元の行が無い」と
    //   「元の行はあるが threshold が NULL」を区別できない。desktop・mobile の両方で確かめる
    await db
      .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'null threshold site', ?3)`)
      .bind(siteNullThreshold, OWNER_A, "9".repeat(32))
      .run();
    await db
      .prepare(`insert into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'null threshold popup', 'active')`)
      .bind(popupNullThreshold, OWNER_A, siteNullThreshold, "8".repeat(32))
      .run();
    await db
      .prepare(`update popup_triggers set enabled = 1, threshold = null where popup_id = ?1 and kind = 'scroll'`)
      .bind(popupNullThreshold)
      .run();
    await db
      .prepare(`update popup_mobile_display set triggers_mode = 'custom' where popup_id = ?1`)
      .bind(popupNullThreshold)
      .run();
    await db
      .prepare(`update popup_mobile_triggers set enabled = 1, threshold = null where popup_id = ?1 and kind = 'scroll'`)
      .bind(popupNullThreshold)
      .run();

    applyRemaining0005(dir);
  });
  afterAll(async () => {
    await dispose();
  });

  it("🔴 稼働中のポップがあれば、desktop は popups・popup_triggers の値、mobile は popup_mobile_display/triggers の値とモードを引き継ぐ", async () => {
    const result = value(await admin.getSiteDisplay(db, OWNER_A, siteActive));
    expect(result.desktop).toMatchObject({
      triggersMode: null,
      frequencyMode: null,
      suppressDays: 9,
      sessionImpressions: 2,
      postConversionDays: 14,
      minDisplayDelaySeconds: 5,
    });
    expect(result.desktop.triggers.find((t) => t.kind === "scroll")).toEqual({ kind: "scroll", enabled: true, threshold: 77 });
    expect(result.mobile).toMatchObject({
      triggersMode: "custom",
      frequencyMode: "custom",
      suppressDays: 3,
      sessionImpressions: 1,
      postConversionDays: 1,
      minDisplayDelaySeconds: 1,
    });
    expect(result.mobile.triggers.find((t) => t.kind === "scroll")).toEqual({ kind: "scroll", enabled: true, threshold: 33 });
  });

  it("🔴 稼働中が無ければ、アーカイブしていないポップのうち updated_at が最も新しいものを使う(アーカイブ済みは出どころにしない)", async () => {
    const result = value(await admin.getSiteDisplay(db, OWNER_A, siteStale));
    expect(result.desktop).toMatchObject({
      suppressDays: 21,
      sessionImpressions: 3,
      postConversionDays: 40,
      minDisplayDelaySeconds: 9,
    });
    expect(result.desktop.triggers.find((t) => t.kind === "dwell")).toEqual({ kind: "dwell", enabled: true, threshold: 60 });
    // 999 を使っていない(= アーカイブ済みのポップを出どころにしていない)
    expect(result.desktop.suppressDays).not.toBe(999);
    // mobile はそのポップ(popupStaleNew)の popup_mobile_display(same_as_pc のまま)の値を引き継ぐ
    expect(result.mobile.triggersMode).toBe("same_as_pc");
    expect(result.mobile).toMatchObject({ suppressDays: 21, sessionImpressions: 3, postConversionDays: 40, minDisplayDelaySeconds: 9 });
  });

  it("🔴 ポップが1つも無いサイトは既定値になる。mobile は desktop の写し・same_as_pc", async () => {
    const result = value(await admin.getSiteDisplay(db, OWNER_A, siteEmpty));
    expect(result.desktop).toMatchObject({ suppressDays: 7, sessionImpressions: 1, postConversionDays: 30, minDisplayDelaySeconds: 3 });
    expect(result.desktop.triggers).toEqual(
      expect.arrayContaining([
        { kind: "back", enabled: true, threshold: null },
        { kind: "scroll", enabled: false, threshold: 50 },
        { kind: "idle", enabled: false, threshold: 30 },
        { kind: "dwell", enabled: false, threshold: 45 },
        { kind: "visibility", enabled: false, threshold: null },
        { kind: "exit_intent", enabled: true, threshold: null },
      ]),
    );
    expect(result.mobile.triggersMode).toBe("same_as_pc");
    expect(result.mobile).toMatchObject({ suppressDays: 7, sessionImpressions: 1, postConversionDays: 30, minDisplayDelaySeconds: 3 });
    expect(result.mobile.triggers).toEqual(result.desktop.triggers);
  });

  it("🔴🔴 行はあるが threshold が NULL のまま引き継いだポップは、desktop・mobile とも threshold が NULL のまま(既定値の 50 に化けない)", async () => {
    const result = value(await admin.getSiteDisplay(db, OWNER_A, siteNullThreshold));
    expect(result.desktop.triggers.find((t) => t.kind === "scroll")).toEqual({ kind: "scroll", enabled: true, threshold: null });
    expect(result.mobile.triggersMode).toBe("custom");
    expect(result.mobile.triggers.find((t) => t.kind === "scroll")).toEqual({ kind: "scroll", enabled: true, threshold: null });
  });

  it("🔴 移行後の行数: サイト数 × 2 = site_display_settings・サイト数 × 12 = site_display_triggers", async () => {
    const siteCount = (await db.prepare(`select count(*) as c from sites where owner_id = ?1`).bind(OWNER_A).first<{ c: number }>())!.c;
    const settingsCount = (
      await db.prepare(`select count(*) as c from site_display_settings where owner_id = ?1`).bind(OWNER_A).first<{ c: number }>()
    )!.c;
    const triggersCount = (
      await db.prepare(`select count(*) as c from site_display_triggers where owner_id = ?1`).bind(OWNER_A).first<{ c: number }>()
    )!.c;
    expect(siteCount, "サイトを作っていない = 何も測っていない").toBe(4);
    expect(settingsCount).toBe(siteCount * 2);
    expect(triggersCount).toBe(siteCount * 12);
  });
});

describe("付け替え: ポップ編集画面の頻度・きっかけ API は、そのポップのサイトの desktop 行を読み書きする", () => {
  let t: TestD1;
  let db: D1Database;

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴 updateFrequency / setTriggerEnabled はサイトの desktop 行に書く。凍結した popups/popup_triggers を直接書き換えても getPopup/listTriggers の値は変わらない", async () => {
    const siteId = value(await admin.createSite(db, OWNER_A, { name: "s", allowedOrigins: [] })).id;
    const popupId = value(await admin.createPopup(db, OWNER_A, siteId, { name: "p" })).id;

    value(
      await admin.updateFrequency(db, OWNER_A, popupId, {
        suppressDays: 11,
        sessionImpressions: 4,
        postConversionDays: 22,
        minDisplayDelaySeconds: 6,
      }),
    );
    value(await admin.setTriggerEnabled(db, OWNER_A, popupId, "idle", true));

    const popup = value(await admin.getPopup(db, OWNER_A, popupId));
    expect(popup).toMatchObject({ suppressDays: 11, sessionImpressions: 4, postConversionDays: 22, minDisplayDelaySeconds: 6 });
    const triggers = value(await admin.listTriggers(db, OWNER_A, popupId));
    expect(triggers.find((tr) => tr.kind === "idle")?.enabled).toBe(true);

    // サイト側にも同じ値が見える(同じ行を見ている)
    const site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.desktop).toMatchObject({ suppressDays: 11, sessionImpressions: 4, postConversionDays: 22, minDisplayDelaySeconds: 6 });

    // 🔴 凍結した popups の頻度列・popup_triggers を直接書き換えても、getPopup/listTriggers は変わらない
    await db
      .prepare(`update popups set suppress_days = 999, session_impressions = 999, post_conversion_days = 999, min_display_delay_seconds = 999 where id = ?1`)
      .bind(popupId)
      .run();
    await db.prepare(`update popup_triggers set enabled = 0, threshold = 999 where popup_id = ?1 and kind = 'idle'`).bind(popupId).run();

    const popupAfterTamper = value(await admin.getPopup(db, OWNER_A, popupId));
    expect(popupAfterTamper).toMatchObject({ suppressDays: 11, sessionImpressions: 4, postConversionDays: 22, minDisplayDelaySeconds: 6 });
    const triggersAfterTamper = value(await admin.listTriggers(db, OWNER_A, popupId));
    expect(triggersAfterTamper.find((tr) => tr.kind === "idle")?.enabled).toBe(true);
  });

  it("🔴 他人のポップ id では 404(サイトの desktop 行にも触れない)", async () => {
    // 🔴 1インストール=1サイト(所有者ごとに1つ)。前のテストの OWNER_A のサイトを先に消す
    await db.prepare("delete from sites where owner_id = ?1").bind(OWNER_A).run();
    const siteId = value(await admin.createSite(db, OWNER_A, { name: "s2", allowedOrigins: [] })).id;
    const popupId = value(await admin.createPopup(db, OWNER_A, siteId, { name: "p2" })).id;
    expect(
      await admin.updateFrequency(db, OWNER_B, popupId, { suppressDays: 1, sessionImpressions: 1, postConversionDays: 1, minDisplayDelaySeconds: 1 }),
    ).toEqual({ ok: false, failure: { kind: "not_found" } });
    expect(await admin.setTriggerEnabled(db, OWNER_B, popupId, "idle", true)).toEqual({ ok: false, failure: { kind: "not_found" } });
  });
});

describe("サイト単位のモード切替", () => {
  let t: TestD1;
  let db: D1Database;
  let siteId: string;

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    siteId = value(await admin.createSite(db, OWNER_A, { name: "mode", allowedOrigins: [] })).id;
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴 desktop は常に書き込める(モードを持たない)", async () => {
    value(
      await admin.updateSiteFrequency(db, OWNER_A, siteId, "desktop", {
        suppressDays: 5,
        sessionImpressions: 2,
        postConversionDays: 10,
        minDisplayDelaySeconds: 4,
      }),
    );
    value(await admin.setSiteTriggerEnabled(db, OWNER_A, siteId, "desktop", "scroll", true));
    const site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.desktop).toMatchObject({ suppressDays: 5, sessionImpressions: 2, postConversionDays: 10, minDisplayDelaySeconds: 4 });
    expect(site.desktop.triggers.find((t) => t.kind === "scroll")?.enabled).toBe(true);
  });

  it("🔴 mobile は same_as_pc の間、updateSiteFrequency/setSiteTriggerEnabled が not_custom で断られる", async () => {
    expect(
      await admin.updateSiteFrequency(db, OWNER_A, siteId, "mobile", {
        suppressDays: 1,
        sessionImpressions: 1,
        postConversionDays: 1,
        minDisplayDelaySeconds: 1,
      }),
    ).toEqual({ ok: false, failure: { kind: "not_custom" } });
    expect(await admin.setSiteTriggerEnabled(db, OWNER_A, siteId, "mobile", "scroll", false)).toEqual({
      ok: false,
      failure: { kind: "not_custom" },
    });
  });

  it("🔴 custom にする瞬間、その時点の desktop の値を mobile へ写す。以後 desktop を直しても mobile は変わらない", async () => {
    value(await admin.setSiteFrequencyMode(db, OWNER_A, siteId, "custom"));
    value(await admin.setSiteTriggersMode(db, OWNER_A, siteId, "custom"));
    const afterCustom = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(afterCustom.mobile).toMatchObject({ suppressDays: 5, sessionImpressions: 2, postConversionDays: 10, minDisplayDelaySeconds: 4 });
    expect(afterCustom.mobile.triggers.find((t) => t.kind === "scroll")?.enabled).toBe(true);

    value(
      await admin.updateSiteFrequency(db, OWNER_A, siteId, "desktop", {
        suppressDays: 77,
        sessionImpressions: 1,
        postConversionDays: 1,
        minDisplayDelaySeconds: 1,
      }),
    );
    value(await admin.setSiteTriggerEnabled(db, OWNER_A, siteId, "desktop", "scroll", false));
    const stillCustom = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(stillCustom.mobile.suppressDays).toBe(5); // desktop(77)に引きずられていない
    expect(stillCustom.mobile.triggers.find((t) => t.kind === "scroll")?.enabled).toBe(true);
  });

  it("🔴 mobile が custom の間は updateSiteFrequency/setSiteTriggerEnabled が通る", async () => {
    value(
      await admin.updateSiteFrequency(db, OWNER_A, siteId, "mobile", {
        suppressDays: 2,
        sessionImpressions: 2,
        postConversionDays: 2,
        minDisplayDelaySeconds: 2,
      }),
    );
    const site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.mobile).toMatchObject({ suppressDays: 2, sessionImpressions: 2, postConversionDays: 2, minDisplayDelaySeconds: 2 });
  });

  it("🔴 same_as_pc に戻すと値は残るが使われない(次に custom にすると desktop の値で上書きされる)", async () => {
    value(await admin.setSiteFrequencyMode(db, OWNER_A, siteId, "same_as_pc"));
    expect(value(await admin.getSiteDisplay(db, OWNER_A, siteId)).mobile.frequencyMode).toBe("same_as_pc");

    value(
      await admin.updateSiteFrequency(db, OWNER_A, siteId, "desktop", {
        suppressDays: 88,
        sessionImpressions: 1,
        postConversionDays: 1,
        minDisplayDelaySeconds: 1,
      }),
    );
    value(await admin.setSiteFrequencyMode(db, OWNER_A, siteId, "custom"));
    expect(value(await admin.getSiteDisplay(db, OWNER_A, siteId)).mobile.suppressDays).toBe(88);
  });
});

describe("サイトのトリガの閾値", () => {
  let t: TestD1;
  let db: D1Database;
  let siteId: string;

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    siteId = value(await admin.createSite(db, OWNER_A, { name: "threshold", allowedOrigins: [] })).id;
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴 desktop は常に書き込める。null にも戻せる(範囲検査は呼び出し側の責務)", async () => {
    value(await admin.setSiteTriggerThreshold(db, OWNER_A, siteId, "desktop", "scroll", 60));
    let site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.desktop.triggers.find((t) => t.kind === "scroll")?.threshold).toBe(60);

    value(await admin.setSiteTriggerThreshold(db, OWNER_A, siteId, "desktop", "scroll", null));
    site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.desktop.triggers.find((t) => t.kind === "scroll")?.threshold).toBeNull();
  });

  it("🔴 mobile は same_as_pc の間 not_custom で断られ、custom にすると通る", async () => {
    expect(await admin.setSiteTriggerThreshold(db, OWNER_A, siteId, "mobile", "dwell", 20)).toEqual({
      ok: false,
      failure: { kind: "not_custom" },
    });
    value(await admin.setSiteTriggersMode(db, OWNER_A, siteId, "custom"));
    value(await admin.setSiteTriggerThreshold(db, OWNER_A, siteId, "mobile", "dwell", 20));
    const site = value(await admin.getSiteDisplay(db, OWNER_A, siteId));
    expect(site.mobile.triggers.find((t) => t.kind === "dwell")?.threshold).toBe(20);
    // 🔴 desktop の dwell には影響しない(custom になった後は端末ごとに独立)
    expect(site.desktop.triggers.find((t) => t.kind === "dwell")?.threshold).not.toBe(20);
  });

  it("🔴 存在しないサイトは not_found", async () => {
    expect(await admin.setSiteTriggerThreshold(db, OWNER_A, "00000000-0000-0000-0000-000000000000", "desktop", "scroll", 10)).toEqual({
      ok: false,
      failure: { kind: "not_found" },
    });
  });
});

describe("mobile の行はモードが NULL では持てない(CHECK)", () => {
  // 🔴 SQLite の CHECK は式の結果が NULL なら満たしたことになる(false のときだけ断る)。
  //   `(device = 'mobile' and mode in (...)) or (device = 'desktop' and mode is null)` は、
  //   device='mobile' かつ mode が NULL のとき、1項目は `true and NULL` = NULL、2項目は `false` で
  //   `NULL or false` = NULL になり、CHECK は通ってしまう(拒否されない)。`mode is not null` を明示して塞ぐ。
  let t: TestD1;
  let db: D1Database;
  let siteId: string;

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    siteId = value(await admin.createSite(db, OWNER_A, { name: "null mode", allowedOrigins: [] })).id;
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴🔴 mobile の行に triggers_mode = NULL を書こうとすると断られる(desktop は null のままでよい)", async () => {
    const message = await errorOf(() =>
      db.prepare(`update site_display_settings set triggers_mode = null where site_id = ?1 and device = 'mobile'`).bind(siteId).run(),
    );
    expect(message).toContain("CHECK");
    // 断られたので値は変わっていない(same_as_pc のまま)
    expect(value(await admin.getSiteDisplay(db, OWNER_A, siteId)).mobile.triggersMode).toBe("same_as_pc");
  });

  it("🔴🔴 mobile の行に frequency_mode = NULL を書こうとすると断られる", async () => {
    const message = await errorOf(() =>
      db.prepare(`update site_display_settings set frequency_mode = null where site_id = ?1 and device = 'mobile'`).bind(siteId).run(),
    );
    expect(message).toContain("CHECK");
    expect(value(await admin.getSiteDisplay(db, OWNER_A, siteId)).mobile.frequencyMode).toBe("same_as_pc");
  });
});
