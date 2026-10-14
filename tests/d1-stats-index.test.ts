// @vitest-environment node
//
// 🔴 索引 `events_site_kind_occurred_at`(db/migrations/0003_event_stats_index.sql)の検査
//   。
//
// tests/d1-migration-additive.test.ts は「既存のスキーマが変わらないこと」だけを見るので、
// **この索引自体を消しても**(= 0003 の CREATE INDEX を丸ごと消しても)何も落ちない。
// ここは逆に、**この索引が実在し、列順が (site_id, kind, occurred_at) であること**と、
// **`admin.getPopupStats` が実際に書くクエリが、この索引を使って実行計画を組むこと**を直接固定する。
//
// ⚠ **実測で分かったこと**: `events` に複数サイト・各200件の行を**1人の所有者の下**に入れて
//   `ANALYZE` を**実行する前**に `EXPLAIN QUERY PLAN` を撃ったところ、狙った `events_site_kind_occurred_at`
//   ではなく `events_owner_occurred_at` が選ばれた。`ANALYZE` を実行した**後**は、狙いどおりこの索引が
//   選ばれた(この2つの観測事実だけが実測。SQLite の選択アルゴリズムの内部動作そのものは読んでいない=未確認)。
//   → **本番の Cloudflare D1 が `ANALYZE` を自動で走らせるか・走らせる頻度は未確認**。
//   **本番で `ANALYZE` が走っていなければ、この索引は意図どおりに使われない可能性がある**。
//
// 🔴🔴 1インストール=1サイト(所有者ごとに1つ。db/migrations/0006_sites_single_per_owner.sql)の
//   あとは、`admin.createSite` を通した通常の経路では「1人の所有者が複数サイトを持つ」状態を**新しくは**
//   作れない。ただし 0006 は**追加だけ**(既存の行は1つも変えない・既存の複数サイト所有者はそのまま残る=
//   README で約束している)。そこで、この検査は**0006 を当てる前の状態で**偏ったデータ
//   (1人の所有者に5サイト・各20)を作り、**そのあとで 0006 を当てて**から `EXPLAIN QUERY PLAN` を読む
//   ——「移行前から複数サイトを持っていた所有者」が実際に遭遇する状況をそのまま再現している。
//   ⚠ `openTestD1()` は毎回「0001〜最新」を通しで当てるので、この再現は専用のワークスペースでしかできない
//   (`tests/d1-site-display.test.ts` の既存データ引き継ぎの検査と同じ理由)。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import * as admin from "../src/lib/data/admin";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "db/migrations");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const BEFORE_0006 = FILES.filter((f) => f < "0006");
const AFTER_0006 = FILES.filter((f) => f >= "0006");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** 0006 より前だけを当てたワークスペース(「0006 を当てる前からすでに複数サイトを持つ所有者」を作る)。 */
function workspace(): { dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-stats-mig-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "m"));
  writeFileSync(path.join(dir, "w.js"), 'export default { fetch() { return new Response("") } }');
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "stats-index-check",
      main: "w.js",
      compatibility_date: "2026-09-30",
      d1_databases: [{ binding: "DB", database_name: "stats-index-check", database_id: "00000000-0000-4000-8000-0000000000dd", migrations_dir: "m" }],
    }),
  );
  for (const file of BEFORE_0006) cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file));
  apply(dir);
  return { dir };
}

function apply(dir: string): void {
  execFileSync(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "stats-index-check", "--local", "--persist-to", path.join(dir, "p"), "-c", path.join(dir, "wrangler.jsonc")],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
}

function applyRemaining0006(dir: string): void {
  for (const file of AFTER_0006) cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file));
  apply(dir);
}

async function openDb(dir: string): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(dir, "wrangler.jsonc"),
    persist: { path: path.join(dir, "p", "v3") },
  });
  return { db: proxy.env.DB, dispose: () => proxy.dispose() };
}

const INDEX_NAME = "events_site_kind_occurred_at";

/** `admin.getPopupStats` が書く2つのクエリ(直近7日・累計)と同じ形。実行計画を確かめるためだけに複写する。 */
const SEVEN_DAY_SQL = `select popup_id, kind, count(*) as n from events
   where site_id = ?1 and owner_id = ?2 and occurred_at >= ?3
     and kind in ('impression', 'click', 'close')
   group by popup_id, kind`;
const LIFETIME_SQL = `select popup_id, kind, count(*) as n from events
   where site_id = ?1 and owner_id = ?2
     and kind in ('impression', 'click', 'close')
   group by popup_id, kind`;

describe(`索引 ${INDEX_NAME}`, () => {
  let dir: string;
  let db: D1Database;
  let dispose: () => Promise<void>;
  const ownerId = crypto.randomUUID();
  let targetSiteId = "";

  beforeAll(async () => {
    const ws = workspace();
    dir = ws.dir;
    const opened = await openDb(dir);
    db = opened.db;
    dispose = opened.dispose;

    /*
      🔴 0006(sites_single)を当てる**前**の状態で、1人の所有者に5サイト・各200件の行を入れる
      (実行計画は「他に選べる索引がどれだけ有利に見えるか」で変わる=実測・上の注記。
      `events_owner_occurred_at` 等の既存の索引と比べさせるため、複数サイトに分けて実データ規模で
      行を入れる)。その後に 0006 を当て(追加だけなので、入れたデータは1行も変わらない)、
      `ANALYZE` してから実行計画を読む。
    */
    value(await admin.ensureOwner(db, ownerId));
    for (let i = 0; i < 5; i += 1) {
      const siteId = value(await admin.createSite(db, ownerId, { name: `site-${i}`, allowedOrigins: [] })).id;
      if (i === 0) targetSiteId = siteId;
      const popupId = value(await admin.createPopup(db, ownerId, siteId, { name: "p" })).id;
      const variantId = value(
        await admin.createVariant(db, ownerId, popupId, {
          kind: "text",
          content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" },
          destinationUrl: "https://offer.example.com/",
        }),
      ).id;
      const insert = db.prepare(
        `insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device)
         values (?1, ?2, ?3, ?4, 'impression', 'exit_intent', ?5, 'desktop')`,
      );
      const batch = Array.from({ length: 200 }, () => insert.bind(ownerId, siteId, popupId, variantId, crypto.randomUUID()));
      // D1 の batch は一度に渡せる本数に上限があるので、50件ずつに分ける
      for (let start = 0; start < batch.length; start += 50) await db.batch(batch.slice(start, start + 50));
    }

    // 🔴 ここで初めて 0006 を当てる(5サイトとも owner_id は同じ。当てても失敗せず、既存行は変わらない)。
    //   ⚠ `db`(開いたままの getPlatformProxy)を dispose せずに別プロセスで migrations apply する
    //   (`tests/d1-site-display.test.ts` の既存データ引き継ぎの検査と同じ形。同じ持続先ディレクトリの
    //   sqlite ファイルを直接当てるので、開いたままのハンドルからも当てた後の値が見える)。
    applyRemaining0006(dir);

    await db.prepare("ANALYZE").run();
  });
  afterAll(async () => {
    await dispose?.();
  });

  it("🔴 存在し、列の順が (site_id, kind, occurred_at) である(sqlite_master + pragma_index_info)", async () => {
    const row = await db
      .prepare(`select sql from sqlite_master where type = 'index' and name = ?1`)
      .bind(INDEX_NAME)
      .first<{ sql: string }>();
    expect(row, `索引 ${INDEX_NAME} が存在しない`).not.toBeNull();
    expect(row?.sql).toContain("events");

    const columns = (
      await db.prepare(`select name from pragma_index_info(?1) order by seqno`).bind(INDEX_NAME).all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(columns).toEqual(["site_id", "kind", "occurred_at"]);
  });

  it("🔴 0006 を当てた後も、ANALYZE 後は admin.getPopupStats が書くクエリ(直近7日・累計)の両方がこの索引を使う(実測の前提つき。上の注記)", async () => {
    for (const [sql, params] of [
      [SEVEN_DAY_SQL, [targetSiteId, ownerId, "2000-01-01T00:00:00.000Z"]],
      [LIFETIME_SQL, [targetSiteId, ownerId]],
    ] as const) {
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results;
      const detail = plan.map((p) => p.detail).join(" | ");
      expect(detail, `実行計画: ${detail}`).toContain(INDEX_NAME);
    }
  });

  it("✅ admin.getPopupStats は、空のサイトに対しても正しく空を返す(実行計画の検査が実物の関数と食い違っていないこと)", async () => {
    // 🔴 1インストール=1サイト。上の5サイトの所有者とは別の、新しい所有者を使う
    const emptyOwnerId = crypto.randomUUID();
    value(await admin.ensureOwner(db, emptyOwnerId));
    const siteId = value(await admin.createSite(db, emptyOwnerId, { name: "索引の検査(空)", allowedOrigins: [] })).id;
    const result = value(await admin.getPopupStats(db, emptyOwnerId, siteId));
    expect(result).toEqual({});
  });
});
