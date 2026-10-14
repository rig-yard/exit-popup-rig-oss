// @vitest-environment node
//
// 1インストール=1サイト。
// 🔴 ここは**状態**を測る:
//   ① 同じ所有者で2つ目のサイトを作ると断られる(既存の上限超過と同じ形=`adpop:limit:sites`)
//   ② 別の所有者なら(同じインストールの中でも)1つ目は作れる
//   ③ 0006 を当てる前からすでに1人が2サイト以上持っていた環境でも、移行そのものは失敗せず、
//      既存のサイトは1行も変わらず残る(新しいサイトがもう作れなくなるだけ)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

describe("① 同じ所有者の2つ目は断られる / ② 別の所有者なら作れる(実物の D1・データ層を通して)", () => {
  let t: TestD1;
  let db: D1Database;

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    value(await admin.ensureOwner(db, OWNER_B));
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("✅ 1つ目は作れる", async () => {
    expect((await admin.createSite(db, OWNER_A, { name: "最初の1つ", allowedOrigins: [] })).ok).toBe(true);
  });

  it("🔴 同じ所有者の2つ目は limit/sites で断られ、1つ目は1行も変わらない", async () => {
    const before = (await db.prepare("select * from sites where owner_id = ?1").bind(OWNER_A).all()).results;
    expect(await admin.createSite(db, OWNER_A, { name: "2つ目", allowedOrigins: [] })).toEqual({
      ok: false,
      failure: { kind: "limit", target: "sites" },
    });
    const after = (await db.prepare("select * from sites where owner_id = ?1").bind(OWNER_A).all()).results;
    expect(after).toEqual(before);
  });

  it("✅ 別の所有者の1つ目は、他の所有者が先に持っていても作れる", async () => {
    expect((await admin.createSite(db, OWNER_B, { name: "B の最初の1つ", allowedOrigins: [] })).ok).toBe(true);
  });

  it("🔴 B もすでに1つ持っているので、B の2つ目も断られる", async () => {
    expect(await admin.createSite(db, OWNER_B, { name: "B の2つ目", allowedOrigins: [] })).toEqual({
      ok: false,
      failure: { kind: "limit", target: "sites" },
    });
  });
});

/*
  ③ 移行の安全性: 0006 を当てる前からすでに2サイト持っている所有者がいる環境を実際に作ってから
  0006 を当て、①失敗しない ②既存の2サイトが1行も変わらない ③その所有者はもう3つ目を作れない、
  を実物の `wrangler d1 migrations apply --local` で確かめる。
  ⚠ `openTestD1()` は毎回「0001〜最新」を通しで当てるので、既存データの移行そのものは
  この専用のワークスペースでしか再現できない(d1-site-display.test.ts の既存データ引き継ぎの検査と同じ理由)。
*/
describe("③ 既存が2つあっても移行で壊れない(0006 を当てる前の状態から)", () => {
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

  function workspace(): { dir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "adpop-s1b-mig-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "m"));
    writeFileSync(path.join(dir, "w.js"), 'export default { fetch() { return new Response("") } }');
    writeFileSync(
      path.join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "s1b-check",
        main: "w.js",
        compatibility_date: "2026-09-30",
        d1_databases: [{ binding: "DB", database_name: "s1bcheck", database_id: "00000000-0000-4000-8000-0000000000cc", migrations_dir: "m" }],
      }),
    );
    for (const file of BEFORE_0006) cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file));
    apply(dir);
    return { dir };
  }

  function apply(dir: string): void {
    execFileSync(
      process.execPath,
      [WRANGLER, "d1", "migrations", "apply", "s1bcheck", "--local", "--persist-to", path.join(dir, "p"), "-c", path.join(dir, "wrangler.jsonc")],
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

  it("🔴🔴 0006 を当てる前からすでに2サイト持つ所有者がいても、当てても失敗せず、2サイトとも1行も変わらず残り、3つ目はもう作れない", async () => {
    const ws = workspace();
    const { db, dispose } = await openDb(ws.dir);
    try {
      await db.prepare("insert into owners (id) values (?1)").bind(OWNER_A).run();
      const siteOld1 = crypto.randomUUID();
      const siteOld2 = crypto.randomUUID();
      await db
        .prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, '既存1', ?3)")
        .bind(siteOld1, OWNER_A, "a".repeat(32))
        .run();
      await db
        .prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, '既存2', ?3)")
        .bind(siteOld2, OWNER_A, "b".repeat(32))
        .run();
      const before = (await db.prepare("select * from sites where owner_id = ?1 order by rowid").bind(OWNER_A).all()).results;

      // 🔴 0006 を当てる(失敗しないこと自体が検査)
      applyRemaining0006(ws.dir);

      const after = (await db.prepare("select * from sites where owner_id = ?1 order by rowid").bind(OWNER_A).all()).results;
      expect(after, "既存の2サイトが変わった").toEqual(before);

      // 3つ目はもう作れない(既存の上限超過と同じ形で断られる)
      const err = await db
        .prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, '3つ目', ?3)")
        .bind(crypto.randomUUID(), OWNER_A, "c".repeat(32))
        .run()
        .then(
          () => "",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
      expect(err).toContain("adpop:limit:sites");
    } finally {
      await dispose();
    }
  });
});
