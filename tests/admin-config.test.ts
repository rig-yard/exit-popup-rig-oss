// @vitest-environment node
//
// Worker の設定ファイル(wrangler.*.jsonc)の値を固定する。
// ⚠ 測っているのは「設定ファイルにそう書いてある」まで。Cloudflare 側で実際にそう効くかは、デプロイ後でないと測れない。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRET_NAMES } from "../src/admin/config";
import { customDomainRouteProblems, distinctHostProblems, workersDevDisabledProblems } from "../scripts/custom-domain-guard.mjs";
import { databaseIdMismatchProblems, isPlaceholderDatabaseId, PLACEHOLDER_DATABASE_ID } from "../scripts/database-id-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./helpers/wrangler-config";

type Config = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
  vars?: Record<string, string>;
  observability?: { logs?: { invocation_logs?: boolean } };
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  d1_databases?: Array<{ binding: string; database_name: string; database_id?: string }>;
  build?: { command?: string };
};

describe.each([
  ["配信", DELIVERY_WRANGLER_PATH],
  ["管理画面", ADMIN_WRANGLER_PATH],
])("%s の Worker の設定", (_label, file) => {
  const config = readWranglerConfig(file) as Config;

  it("🔴 Version URL(preview_urls)を切り、workers_dev を false にしている(既定値に頼らない)", () => {
    expect(config.preview_urls).toBe(false);
    expect(config.workers_dev).toBe(false);
  });

  it("🔴 呼び出しのログ(invocation logs)を残さない", () => {
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it("D1 と R2 のバインドが同じ名前で揃っている", () => {
    expect(config.d1_databases?.map((d) => [d.binding, d.database_name])).toEqual([["DB", "adpop"]]);
    expect(config.r2_buckets?.map((r) => [r.binding, r.bucket_name])).toEqual([["IMAGES", "adpop-images"]]);
  });

  it("🔴 秘密の鍵の名前が、設定ファイルのどこにも現れない(vars に書く事故を止める)", () => {
    // ⚠ コメントの中の「書かない」という説明は許す。JSON として読んだ値の中に無いことを見る
    const values = JSON.stringify(config);
    for (const name of SECRET_NAMES) expect(values, name).not.toContain(name);
    expect(config.vars ?? {}).toEqual({});
  });
});

describe(".gitignore", () => {
  it("🔴 .dev.vars で始まるファイルを全部追跡しない(.dev.vars.production など)", () => {
    const lines = readFileSync(".gitignore", "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain(".dev.vars*");
  });
});

describe("2つの wrangler 設定の database_id", () => {
  // 🔴 追跡している設定の database_id は仮の値のまま。自分の値は deploy.local.json に書く
  //   (直接書いた設定を断る判定は tests/deploy-config.test.ts の trackedConfigProblems)。
  it("現在のリポジトリの状態: 両方とも database_id が仮の値で、同じ値", () => {
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH) as Config;
    const admin = readWranglerConfig(ADMIN_WRANGLER_PATH) as Config;
    const deliveryId = delivery.d1_databases?.[0]?.database_id;
    const adminId = admin.d1_databases?.[0]?.database_id;
    expect(deliveryId).toBe(PLACEHOLDER_DATABASE_ID);
    expect(adminId).toBe(PLACEHOLDER_DATABASE_ID);
  });

  it("通る例: 両方とも実在の値で、かつ一致している", () => {
    expect(
      databaseIdMismatchProblems({
        deliveryDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
        adminDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
      }),
    ).toEqual([]);
  });

  it("🔴 落ちる例: id が割れていれば databaseIdMismatchProblems が検出する(判定そのものの検査)", () => {
    expect(databaseIdMismatchProblems({ deliveryDatabaseId: "a", adminDatabaseId: "b" }).length).toBeGreaterThan(0);
    expect(databaseIdMismatchProblems({ deliveryDatabaseId: "a", adminDatabaseId: undefined }).length).toBeGreaterThan(
      0,
    );
  });

  it("🔴 落ちる例: 仮の値どうしが一致していても断る(「非空かつ一致」だけを見る実装だと見逃す)", () => {
    const problems = databaseIdMismatchProblems({
      deliveryDatabaseId: PLACEHOLDER_DATABASE_ID,
      adminDatabaseId: PLACEHOLDER_DATABASE_ID,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.kind === "placeholder")).toBe(true);
  });

  it("🔴 追跡している設定に入れているプレースホルダは、仮の値として断る", () => {
    expect(PLACEHOLDER_DATABASE_ID).toBe("REPLACE_WITH_YOUR_D1_DATABASE_ID");
    expect(isPlaceholderDatabaseId(PLACEHOLDER_DATABASE_ID)).toBe(true);
  });

  it("🔴 落ちる例: 片方だけ仮の値(もう片方は実在の値)", () => {
    const problems = databaseIdMismatchProblems({
      deliveryDatabaseId: PLACEHOLDER_DATABASE_ID,
      adminDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
    });
    expect(problems.some((p) => p.kind === "placeholder")).toBe(true);
    expect(problems.some((p) => p.kind === "mismatch")).toBe(true);
  });

  it("isPlaceholderDatabaseId は定数と完全一致したときだけ true", () => {
    expect(isPlaceholderDatabaseId(PLACEHOLDER_DATABASE_ID)).toBe(true);
    expect(isPlaceholderDatabaseId("REPLACE_WITH_YOUR_D1_DATABASE_ID_2")).toBe(false);
    expect(isPlaceholderDatabaseId(undefined)).toBe(false);
  });
});

describe("Custom Domain の routes(workers.dev・zone の routes に頼らない)", () => {
  const HOST = "adpop.example.net";

  // 🔴 追跡している設定は「構造」(Custom Domain 1件・workers_dev: false)を見る。
  //   ホスト名が仮の値のままであることは tests/deploy-config.test.ts が見る。
  it("現在のリポジトリの状態: 配信・管理画面とも workers_dev: false・Custom Domain 1件の構造になっている", () => {
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH) as Config;
    const admin = readWranglerConfig(ADMIN_WRANGLER_PATH) as Config;

    expect(workersDevDisabledProblems({ label: "配信", workersDev: delivery.workers_dev })).toEqual([]);
    expect(workersDevDisabledProblems({ label: "管理画面", workersDev: admin.workers_dev })).toEqual([]);
    for (const [label, config] of [
      ["配信", delivery],
      ["管理画面", admin],
    ] as const) {
      expect(config.routes?.length, label).toBe(1);
      expect(config.routes?.[0]?.custom_domain, label).toBe(true);
      expect(Object.keys(config.routes?.[0] ?? {}).sort(), label).toEqual(["custom_domain", "pattern"]);
    }
    expect(
      distinctHostProblems({ deliveryHost: delivery.routes?.[0]?.pattern, adminHost: admin.routes?.[0]?.pattern }),
    ).toEqual([]);
  });

  it("✅ 通る例: custom_domain: true の素のホスト名1件", () => {
    expect(customDomainRouteProblems({ label: "配信", routes: [{ pattern: HOST, custom_domain: true }] })).toEqual([]);
  });

  it("🔴 落ちる例: 同じホストを配信と管理画面で取り合う", () => {
    expect(distinctHostProblems({ deliveryHost: HOST, adminHost: HOST }).length).toBeGreaterThan(0);
    expect(distinctHostProblems({ deliveryHost: HOST, adminHost: "admin.example.net" })).toEqual([]);
  });

  it("🔴 落ちる例: workers_dev が true", () => {
    expect(workersDevDisabledProblems({ label: "配信", workersDev: true }).length).toBeGreaterThan(0);
    expect(workersDevDisabledProblems({ label: "配信", workersDev: undefined }).length).toBeGreaterThan(0);
  });

  it("🔴 落ちる例: routes が無い", () => {
    expect(customDomainRouteProblems({ label: "配信", routes: undefined }).length).toBeGreaterThan(0);
    expect(customDomainRouteProblems({ label: "配信", routes: [] }).length).toBeGreaterThan(0);
  });

  it("🔴 落ちる例: zone の route(custom_domain が付いていない)が混ざっている", () => {
    const problems = customDomainRouteProblems({ label: "配信", routes: [{ pattern: `${HOST}/*` }] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p: string) => p.includes("zone の routes"))).toBe(true);
  });

  it.each([
    ["ワイルドカード", "*.example.net"],
    ["パス付き", `${HOST}/*`],
    ["スキーム付き", `https://${HOST}`],
    ["ポート付き", `${HOST}:8787`],
    ["ドットの無い名前", "localhost"],
  ])("🔴 落ちる例: custom_domain: true でも pattern が素のホスト名ではない(%s)", (_label, pattern) => {
    const problems = customDomainRouteProblems({ label: "配信", routes: [{ pattern, custom_domain: true }] });
    expect(problems.some((p: string) => p.includes("素のホスト名"))).toBe(true);
  });

  it.each(["example.com", "adpop.example.com", "adpop-admin.example.com"])(
    "🔴 落ちる例: プレースホルダ(%s)のままは断る",
    (pattern) => {
      const problems = customDomainRouteProblems({ label: "配信", routes: [{ pattern, custom_domain: true }] });
      expect(problems.some((p: string) => p.includes("プレースホルダ"))).toBe(true);
    },
  );

  it("🔴 落ちる例: 別の route が増えている(相乗り)", () => {
    const problems = customDomainRouteProblems({
      label: "配信",
      routes: [
        { pattern: HOST, custom_domain: true },
        { pattern: "other.example.net", custom_domain: true },
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  // 🔴 `custom_domain: true` とホストが正しくても、route オブジェクトに他の鍵が混ざっていたら
  //   合格にしない。`pattern`・`custom_domain` 以外の鍵が1つでもあれば、それぞれ個別に落ちる。
  it.each([
    ["zone_name(zone の route の鍵)", { zone_name: "example.net" }],
    ["zone_id(zone の route の鍵)", { zone_id: "abc123" }],
    ["enabled: false(「正しいホストで配信中」という保証を壊す)", { enabled: false }],
    ["previews_enabled: true", { previews_enabled: true }],
  ])("🔴 落ちる例: route に %s が混ざっている", (_label, extra) => {
    const problems = customDomainRouteProblems({
      label: "配信",
      routes: [{ pattern: HOST, custom_domain: true, ...extra }],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p: string) => p.includes("以外の鍵がある"))).toBe(true);
  });
});

describe("build.command の配線(toContain から厳密化)", () => {
  // 🔴 `build.command` からどれかの検査を外しても CI は気づかない(dry-run の前に別ステップで
  //   `npm run build` 等を一度は走らせているため)。この検査は**設定ファイルの文字列**を見て、
  //   deploy 前に必ず走るはずのコマンドが実際にそこへ書かれているかを固定する。
  //
  // 🔴 以前は `toContain` だけだったため、`node scripts/check-custom-domain.mjs || true`
  //   のように無効化しても、文字列としては「含んでいる」ので通ってしまっていた(`;` で別のコマンドを
  //   こっそり足す場合も同様)。` && ` で分割し、**各要素が期待した文字列と完全一致**しているか・
  //   コマンド全体に `;`/`||` が無いかまで見る。

  /** `build.command` を ` && ` で分割する(他の区切り方は許さない)。 */
  function splitBuildCommand(command: string): string[] {
    return command.split(" && ").map((segment) => segment.trim());
  }

  it("🔴 管理画面: build.command が期待した4コマンドの ` && ` 連結と完全一致(`;`/`||` が無い)", () => {
    const admin = readWranglerConfig(ADMIN_WRANGLER_PATH) as Config;
    const command = admin.build?.command ?? "";
    expect(command).not.toContain(";");
    expect(command).not.toContain("||");
    expect(splitBuildCommand(command)).toEqual([
      "npm run build",
      "node scripts/check-admin-headers.mjs",
      "node scripts/check-database-ids-match.mjs",
      "node scripts/check-custom-domain.mjs",
    ]);
  });

  it("🔴 配信: build.command が期待した5コマンドの ` && ` 連結と完全一致(`;`/`||` が無い)", () => {
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH) as Config;
    const command = delivery.build?.command ?? "";
    expect(command).not.toContain(";");
    expect(command).not.toContain("||");
    expect(splitBuildCommand(command)).toEqual([
      "npm run build:embed",
      "npm run check:bundle-size",
      "npm run check:embed-independence",
      "node scripts/check-database-ids-match.mjs",
      "node scripts/check-custom-domain.mjs",
    ]);
  });

  // 🔴 落ちる例: 判定(splitBuildCommand + toEqual)自体が、`|| true` を見逃さないことを固定する。
  it("🔴 落ちる例: 最後のコマンドに `|| true` を付けて無効化すると、分割後の要素が一致しない", () => {
    const disabled = "node scripts/check-admin-headers.mjs && node scripts/check-custom-domain.mjs || true";
    expect(splitBuildCommand(disabled)).not.toEqual([
      "node scripts/check-admin-headers.mjs",
      "node scripts/check-custom-domain.mjs",
    ]);
  });

  it("🔴 落ちる例: `;` で別のコマンドを継ぎ足しても、`;` の不在チェックで検出できる", () => {
    const smuggled = "node scripts/check-admin-headers.mjs && node scripts/check-custom-domain.mjs; echo ok";
    expect(smuggled.includes(";")).toBe(true);
  });
});
