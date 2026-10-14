// @vitest-environment node
//
// 🔴 索引 `events_variant_kind`(db/migrations/0008_variant_stats_index.sql)の検査。
//   `tests/d1-migration-additive.test.ts` は「既存のスキーマが変わらない
//   こと」だけを見るので、**この索引自体を消しても**(0008のCREATE INDEXを丸ごと消しても)何も落ちない。
//   ここは逆に、**この索引が実在し、列順が (variant_id, kind) であること**と、
//   **`admin.getVariantStats` が実際に書くクエリが、この索引を使って実行計画を組むこと**を直接固定する
//   (`tests/d1-stats-index.test.ts` と同じ方式)。
//
// ⚠ 既存の `tests/d1-stats-index.test.ts` は、範囲条件(occurred_at >= ?)を含む・複数の索引が
//   競合する状況だったため `ANALYZE` の有無で選ばれる索引が変わった(実測)。
//   このクエリ(variant_id・owner_id の等値条件だけ)はその事情と異なる可能性があるため、
//   「ANALYZE前」「ANALYZE後」の**両方**で実際に実行計画を取り、索引が選ばれることを確かめる
//   (推測で済ませず実測する)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import * as admin from "../src/lib/data/admin";
import { openTestD1, type TestD1 } from "./helpers/d1";

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const INDEX_NAME = "events_variant_kind";

/** `admin.getVariantStats` が実際に書くクエリと同じ形。実行計画を確かめるためだけに複写する。 */
const VARIANT_STATS_SQL = `select kind, count(*) as n from events
   where variant_id = ?1 and owner_id = ?2
     and kind in ('impression', 'click', 'close')
   group by kind`;

describe(`索引 ${INDEX_NAME}(0008)`, () => {
  let t: TestD1;
  let db: D1Database;
  const ownerId = crypto.randomUUID();
  let targetVariantId = "";
  let siteId = "";

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;

    /*
      🔴 「他の所有者・他のパターンの行が十分に多い」状況を作ってから、対象パターンの実行計画を読む
      (件数が少ないと、索引が無くても全表走査が速くてプランナーが索引を選ばない可能性があるため。
      `tests/d1-stats-index.test.ts` と同じ考え方で、実データ規模を作ってから測る)。
    */
    value(await admin.ensureOwner(db, ownerId));
    siteId = value(await admin.createSite(db, ownerId, { name: "削除確認索引", allowedOrigins: [] })).id;
    const popupId = value(await admin.createPopup(db, ownerId, siteId, { name: "p" })).id;
    for (let i = 0; i < 5; i += 1) {
      const variantId = value(
        await admin.createVariant(db, ownerId, popupId, {
          kind: "text",
          content: { headline: `v${i}`, body: "", buttonLabel: "", imageAlt: "" },
          destinationUrl: "https://offer.example.com/",
        }),
      ).id;
      if (i === 0) targetVariantId = variantId;
      const insert = db.prepare(
        `insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device)
         values (?1, ?2, ?3, ?4, 'impression', 'exit_intent', ?5, 'desktop')`,
      );
      const batch = Array.from({ length: 200 }, () => insert.bind(ownerId, siteId, popupId, variantId, crypto.randomUUID()));
      // D1 の batch は一度に渡せる本数に上限があるので、50件ずつに分ける
      for (let start = 0; start < batch.length; start += 50) await db.batch(batch.slice(start, start + 50));
    }
  });

  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴 存在し、列の順が (variant_id, kind) である(sqlite_master + pragma_index_info)", async () => {
    const row = await db
      .prepare(`select sql from sqlite_master where type = 'index' and name = ?1`)
      .bind(INDEX_NAME)
      .first<{ sql: string }>();
    expect(row, `索引 ${INDEX_NAME} が存在しない`).not.toBeNull();
    expect(row?.sql).toContain("events");

    const columns = (
      await db.prepare(`select name from pragma_index_info(?1) order by seqno`).bind(INDEX_NAME).all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(columns).toEqual(["variant_id", "kind"]);
  });

  it("🔴 ANALYZE 前でも、admin.getVariantStats が書くクエリがこの索引を使う(等値条件だけなので、範囲条件のあるクエリとは事情が違うことを実測で確かめる)", async () => {
    const plan = (
      await db.prepare(`EXPLAIN QUERY PLAN ${VARIANT_STATS_SQL}`).bind(targetVariantId, ownerId).all<{ detail: string }>()
    ).results;
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail, `実行計画(ANALYZE前): ${detail}`).toContain(INDEX_NAME);
  });

  it("🔴 ANALYZE 後も同じ索引が選ばれる", async () => {
    await db.prepare("ANALYZE").run();
    const plan = (
      await db.prepare(`EXPLAIN QUERY PLAN ${VARIANT_STATS_SQL}`).bind(targetVariantId, ownerId).all<{ detail: string }>()
    ).results;
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail, `実行計画(ANALYZE後): ${detail}`).toContain(INDEX_NAME);
  });

  it("✅ admin.getVariantStats は、索引の検査が実物の関数と食い違っていないこと(イベントが無いパターンは0)", async () => {
    // 🔴 対象ポップはすでに上限(VARIANT_LIMIT=5)まで埋めているので、別のポップを使う
    const emptyPopupId = value(await admin.createPopup(db, ownerId, siteId, { name: "空のポップ" })).id;
    const emptyVariantId = value(
      await admin.createVariant(db, ownerId, emptyPopupId, {
        kind: "text",
        content: { headline: "空", body: "", buttonLabel: "", imageAlt: "" },
        destinationUrl: "https://offer.example.com/",
      }),
    ).id;
    const result = value(await admin.getVariantStats(db, ownerId, emptyVariantId));
    expect(result).toEqual({ impression: 0, click: 0, close: 0 });
  });
});
