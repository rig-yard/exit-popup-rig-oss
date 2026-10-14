// @vitest-environment node
//
// 自分のデプロイ先の値(ドメイン・D1 の id)を `deploy.local.json` から重ねる仕組みの検査。
// ⚠ 測っているのは「重ねる判定」と「deploy 前の検査スクリプトが、渡された設定を見て落ちる/通る」まで。
//   Cloudflare 側で実際にそのドメインが取れるか・D1 が実在するかは、deploy しないと分からない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run as runAdminHash, secretCommands } from "../scripts/admin-hash.mjs";
import { customDomainRouteProblems, distinctHostProblems } from "../scripts/custom-domain-guard.mjs";
import { deliveryOriginGuardProblems } from "../scripts/delivery-origin-guard.mjs";
import { isLocalOrigin, LOCAL_DATABASE_ID, localDeliveryOrigin, localWorkerName, localWranglerConfig, usesLocalConfig } from "../scripts/local-dev.mjs";
import { isSafeOrigin } from "../scripts/build-admin-headers.mjs";
import { wranglerRunProblems } from "../scripts/wrangler-run-guard.mjs";
import {
  applyLocalOverride,
  isBareHostname,
  isPlaceholderHost,
  isWorkersDevHost,
  localOverrideProblems,
  normalizeHost,
  renderGeneratedConfigs,
  sameHost,
  trackedConfigProblems,
  PLACEHOLDER_ADMIN_HOST,
  PLACEHOLDER_DATABASE_ID,
  PLACEHOLDER_DELIVERY_HOST,
} from "../scripts/deploy-config.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig, REPO_ROOT } from "./helpers/wrangler-config";

const GOOD = { deliveryHost: "adpop.example.net", adminHost: "adpop-admin.example.net", databaseId: "11111111-aaaa-4bbb-8ccc-222222222222" };

describe("localOverrideProblems", () => {
  it("✅ 通る例: 3つの鍵が揃っている", () => {
    expect(localOverrideProblems(GOOD)).toEqual([]);
  });

  it.each([
    ["object ではない", []],
    ["鍵が無い(databaseId)", { ...GOOD, databaseId: undefined }],
    ["空文字(adminHost)", { ...GOOD, adminHost: "" }],
    ["知らない鍵(typo)", { ...GOOD, deliveryhost: "x.example.net" }],
    ["https:// 付き", { ...GOOD, deliveryHost: "https://adpop.example.net" }],
    ["配信のホストがプレースホルダ", { ...GOOD, deliveryHost: PLACEHOLDER_DELIVERY_HOST }],
    ["管理画面のホストがプレースホルダ", { ...GOOD, adminHost: PLACEHOLDER_ADMIN_HOST }],
    ["配信と管理画面が同じホスト", { ...GOOD, adminHost: GOOD.deliveryHost }],
    ["databaseId がプレースホルダ", { ...GOOD, databaseId: PLACEHOLDER_DATABASE_ID }],
  ])("🔴 落ちる例: %s", (_label, local) => {
    expect(localOverrideProblems(local).length).toBeGreaterThan(0);
  });
});

describe("ホスト名の判定", () => {
  it("素のホスト名だけを通す", () => {
    expect(isBareHostname("adpop.example.net")).toBe(true);
    for (const bad of ["", "localhost", "*.a.com", "a.com/x", "https://a.com", "a.com:80", "-a.com", undefined]) {
      expect(isBareHostname(bad), String(bad)).toBe(false);
    }
  });
  it("example.com とそのサブドメインだけをプレースホルダとする(example.net 等は別)", () => {
    expect(isPlaceholderHost("example.com")).toBe(true);
    expect(isPlaceholderHost("a.b.example.com")).toBe(true);
    expect(isPlaceholderHost("notexample.com")).toBe(false);
    expect(isPlaceholderHost("adpop.example.net")).toBe(false);
  });
});

describe("applyLocalOverride", () => {
  it("routes[0].pattern と d1_databases[0].database_id だけを差し替え、他は変えない(元の設定も変えない)", () => {
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
    const before = JSON.stringify(delivery);
    const next = applyLocalOverride(delivery, { host: GOOD.deliveryHost, databaseId: GOOD.databaseId }) as typeof delivery;
    expect(JSON.stringify(delivery)).toBe(before);
    expect((next.routes as Array<{ pattern: string }>)[0].pattern).toBe(GOOD.deliveryHost);
    expect(next.d1_databases?.[0].database_id).toBe(GOOD.databaseId);

    const restore = structuredClone(next) as typeof delivery;
    (restore.routes as Array<{ pattern: string }>)[0].pattern = (delivery.routes as Array<{ pattern: string }>)[0].pattern;
    restore.d1_databases![0].database_id = delivery.d1_databases![0].database_id;
    expect(restore).toEqual(delivery);
  });
});

describe("deploy 前の検査スクリプト(渡された設定を読んで落ちる/通る)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-deploy-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function writeConfigs(local: typeof GOOD | null) {
    let delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
    let admin = readWranglerConfig(ADMIN_WRANGLER_PATH);
    if (local) {
      delivery = applyLocalOverride(delivery, { host: local.deliveryHost, databaseId: local.databaseId }) as typeof delivery;
      admin = applyLocalOverride(admin, { host: local.adminHost, databaseId: local.databaseId }) as typeof admin;
    }
    const files = { ADPOP_DELIVERY_CONFIG: path.join(dir, "d.json"), ADPOP_ADMIN_CONFIG: path.join(dir, "a.json") };
    writeFileSync(files.ADPOP_DELIVERY_CONFIG, JSON.stringify(delivery));
    writeFileSync(files.ADPOP_ADMIN_CONFIG, JSON.stringify(admin));
    return files;
  }
  function run(script: string, env: Record<string, string>) {
    return spawnSync("node", [path.join(REPO_ROOT, "scripts", script)], { env: { ...process.env, ...env }, encoding: "utf8" });
  }

  it.each(["check-custom-domain.mjs", "check-database-ids-match.mjs"])(
    "🔴 %s: 追跡しているプレースホルダのままの設定は落ちる",
    (script) => {
      const result = run(script, writeConfigs(null));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("プレースホルダ");
    },
  );

  it.each(["check-custom-domain.mjs", "check-database-ids-match.mjs"])("✅ %s: 自分の値を重ねた設定は通る", (script) => {
    const result = run(script, writeConfigs(GOOD));
    expect(result.status, result.stderr).toBe(0);
  });

  it("🔴 環境変数を渡さなければ、追跡している設定(プレースホルダ)を検査して落ちる", () => {
    const env = { ADPOP_DELIVERY_CONFIG: "", ADPOP_ADMIN_CONFIG: "" };
    expect(run("check-custom-domain.mjs", env).status).toBe(1);
    expect(run("check-database-ids-match.mjs", env).status).toBe(1);
  });

  it("🔴 workers_dev を true にした設定は、自分の値を重ねても落ちる", () => {
    const files = writeConfigs(GOOD);
    const broken = JSON.parse(readFileSync(files.ADPOP_DELIVERY_CONFIG, "utf8"));
    broken.workers_dev = true;
    writeFileSync(files.ADPOP_DELIVERY_CONFIG, JSON.stringify(broken));
    expect(run("check-custom-domain.mjs", files).status).toBe(1);
  });
});

describe(".gitignore", () => {
  it("🔴 自分の値を書くファイルと、重ねて作った設定を追跡しない", () => {
    const lines = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("deploy.local.json");
    expect(lines).toContain("wrangler.*.generated.jsonc");
  });
});

describe("ホスト名は大文字小文字を区別しない", () => {
  it("🔴 落ちる例: 大文字を混ぜた同じホストは、配信と管理画面で同じ扱いになる", () => {
    expect(sameHost("ADPOP.COMPANY.COM", "adpop.company.com")).toBe(true);
    expect(localOverrideProblems({ ...GOOD, deliveryHost: "ADPOP.EXAMPLE.NET", adminHost: "adpop.example.net" }).length).toBeGreaterThan(0);
    expect(distinctHostProblems({ deliveryHost: "ADPOP.COMPANY.COM", adminHost: "adpop.company.com" }).length).toBeGreaterThan(0);
  });
  it("🔴 落ちる例: 大文字のプレースホルダも仮の値として断る", () => {
    expect(isPlaceholderHost("ADPOP.EXAMPLE.COM")).toBe(true);
    expect(localOverrideProblems({ ...GOOD, deliveryHost: "ADPOP.EXAMPLE.COM" }).length).toBeGreaterThan(0);
    expect(customDomainRouteProblems({ label: "配信", routes: [{ pattern: "ADPOP.EXAMPLE.COM", custom_domain: true }] }).length).toBeGreaterThan(0);
  });
  it("✅ 通る例: 別のホストは別物。重ねた設定には小文字で書く。配信元の比較も大文字小文字を無視する", () => {
    expect(sameHost("a.company.com", "b.company.com")).toBe(false);
    expect(normalizeHost("AbC.Example.NET")).toBe("abc.example.net");
    const next = applyLocalOverride(readWranglerConfig(DELIVERY_WRANGLER_PATH), { host: "ADPOP.Company.NET", databaseId: GOOD.databaseId }) as { routes: Array<{ pattern: string }> };
    expect(next.routes[0].pattern).toBe("adpop.company.net");
    expect(deliveryOriginGuardProblems({ actualOrigin: "https://ADPOP.company.net", expectedOrigin: "https://adpop.company.net" })).toEqual([]);
  });
});

describe("routes の件数は pattern の有無と独立に見る", () => {
  it("🔴 落ちる例: 不完全な追加 route(custom_domain だけ)があっても通さない", () => {
    const routes = [{ pattern: "delivery.company.com", custom_domain: true }, { custom_domain: true }];
    expect(customDomainRouteProblems({ label: "配信", routes }).some((p) => p.includes("routes がちょうど1件ではない"))).toBe(true);
  });
  it("🔴 落ちる例: 2件目が空の object でも通さない", () => {
    expect(customDomainRouteProblems({ label: "配信", routes: [{ pattern: "a.company.com", custom_domain: true }, {}] }).length).toBeGreaterThan(0);
  });
});

describe("deploy.local.json は必須で、追跡している設定は仮の値のままでなければならない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-render-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const out = { deliveryOut: path.join(dir, "d.gen.jsonc"), adminOut: path.join(dir, "a.gen.jsonc") };

  it("🔴 落ちる例: deploy.local.json が無ければ生成せずに止まる(何も書かない)", () => {
    expect(() => renderGeneratedConfigs({ localPath: path.join(dir, "nothing.json"), ...out })).toThrow("deploy.local.json が無い");
    expect(() => readFileSync(out.deliveryOut)).toThrow();
  });

  it("🔴 落ちる例: 追跡している設定に実ドメイン・実 D1 id を直接書いても、deploy.local.json が無ければ通らない", () => {
    const delivery = applyLocalOverride(readWranglerConfig(DELIVERY_WRANGLER_PATH), { host: "adpop.company.com", databaseId: GOOD.databaseId });
    const admin = applyLocalOverride(readWranglerConfig(ADMIN_WRANGLER_PATH), { host: "admin.company.com", databaseId: GOOD.databaseId });
    const deliveryPath = path.join(dir, "d.jsonc");
    const adminPath = path.join(dir, "a.jsonc");
    writeFileSync(deliveryPath, JSON.stringify(delivery));
    writeFileSync(adminPath, JSON.stringify(admin));
    expect(() => renderGeneratedConfigs({ localPath: path.join(dir, "nothing.json"), deliveryPath, adminPath, ...out })).toThrow("deploy.local.json が無い");
    // deploy.local.json があっても、追跡している設定が仮の値でなければ止まる
    const localPath = path.join(dir, "local.json");
    writeFileSync(localPath, JSON.stringify(GOOD));
    expect(() => renderGeneratedConfigs({ localPath, deliveryPath, adminPath, ...out })).toThrow("仮の値");
    expect(() => readFileSync(out.deliveryOut)).toThrow();
  });

  it("✅ 通る例: 仮の値の設定に deploy.local.json を重ねると生成される", () => {
    const localPath = path.join(dir, "ok-local.json");
    writeFileSync(localPath, JSON.stringify({ ...GOOD, deliveryHost: "ADPOP.example.net" }));
    const rendered = renderGeneratedConfigs({ localPath, ...out });
    const delivery = readWranglerConfig(rendered.delivery) as { routes: Array<{ pattern: string }> };
    expect(delivery.routes[0].pattern).toBe("adpop.example.net");
  });

  it("現在のリポジトリの追跡設定は仮の値のまま", () => {
    for (const [label, file, host] of [
      ["配信", DELIVERY_WRANGLER_PATH, PLACEHOLDER_DELIVERY_HOST],
      ["管理画面", ADMIN_WRANGLER_PATH, PLACEHOLDER_ADMIN_HOST],
    ] as const) {
      expect(trackedConfigProblems({ label, config: readWranglerConfig(file), placeholderHost: host }), label).toEqual([]);
    }
  });

  it.each([
    ["ホストが実ドメイン", { routes: [{ pattern: "adpop.company.com", custom_domain: true }], d1_databases: [{ database_id: PLACEHOLDER_DATABASE_ID }] }],
    ["D1 の id が実値", { routes: [{ pattern: PLACEHOLDER_DELIVERY_HOST, custom_domain: true }], d1_databases: [{ database_id: GOOD.databaseId }] }],
    ["routes が2件", { routes: [{ pattern: PLACEHOLDER_DELIVERY_HOST }, { pattern: "x.company.com" }], d1_databases: [{ database_id: PLACEHOLDER_DATABASE_ID }] }],
  ])("🔴 落ちる例: 追跡している設定の %s", (_label, config) => {
    expect(trackedConfigProblems({ label: "配信", config, placeholderHost: PLACEHOLDER_DELIVERY_HOST }).length).toBeGreaterThan(0);
  });
});

describe("admin:hash は生成した設定を使うコマンドを出し、設定が作れなければ何も出さない", () => {
  it("🔴 落ちる例: deploy.local.json が無い(設定が作れない)なら、パスワードもコマンドも表示せず 1 を返す", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runAdminHash({
      render: () => {
        throw new Error("deploy.local.json が無い");
      },
      log: (m: string) => logs.push(m),
      logError: (m: string) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("deploy.local.json");
  });

  it("✅ 通る例: 4つのコマンドはすべて wrangler:admin(生成した設定)経由で、追跡している設定を名指ししない", async () => {
    const logs: string[] = [];
    const code = await runAdminHash({ render: () => ({ delivery: "", admin: "" }), log: (m: string) => logs.push(m), logError: () => {} });
    expect(code).toBe(0);
    const text = logs.join("\n");
    expect(text.match(/npm run wrangler:admin -- secret put /g)).toHaveLength(4);
    expect(text).not.toContain("wrangler.admin.jsonc");
    expect(secretCommands({ passwordHash: "h", rateLimitKey: "k", ownerId: "o" })).toHaveLength(4);
  });
});

describe("wrangler:* の入口(生成した設定でしか補助コマンドを打てない)", () => {
  it("✅ 通る例", () => {
    expect(wranglerRunProblems({ target: "admin", args: ["secret", "put", "ADMIN_EMAIL"] })).toEqual([]);
    expect(wranglerRunProblems({ target: "delivery", args: ["d1", "time-travel", "info", "adpop"] })).toEqual([]);
  });
  it.each([
    ["deploy", { target: "admin", args: ["deploy"] }],
    ["設定の差し替え", { target: "admin", args: ["secret", "list", "-c", "wrangler.admin.jsonc"] }],
    ["--config=", { target: "admin", args: ["secret", "list", "--config=x.jsonc"] }],
    ["知らない対象", { target: "other", args: ["d1"] }],
    ["引数なし", { target: "admin", args: [] }],
  ])("🔴 落ちる例: %s", (_label, input) => {
    expect(wranglerRunProblems(input).length).toBeGreaterThan(0);
  });
});

describe("workers.dev はホスト名に使えない(deploy.local.json と deploy 前の検査の両方で断る)", () => {
  it.each(["foo.workers.dev", "FOO.WORKERS.DEV", "a.b.workers.dev", "workers.dev"])("🔴 落ちる例: %s", (host) => {
    expect(isWorkersDevHost(host)).toBe(true);
    expect(localOverrideProblems({ ...GOOD, deliveryHost: host }).some((p) => p.includes("workers.dev"))).toBe(true);
    expect(localOverrideProblems({ ...GOOD, adminHost: host }).some((p) => p.includes("workers.dev"))).toBe(true);
    expect(customDomainRouteProblems({ label: "配信", routes: [{ pattern: host, custom_domain: true }] }).some((p) => p.includes("workers.dev"))).toBe(true);
  });
  it.each(["adpop.ci.test", "notworkers.dev.example.net", "myworkers.dev", "workers.dev.example.net"])("✅ 通る例: %s は workers.dev ではない", (host) => {
    expect(isWorkersDevHost(host)).toBe(false);
  });
});

describe("ローカル開発の入口(生成した設定を通る。追跡している設定を直接 wrangler に渡さない)", () => {
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  it("🔴 落ちる例: どの npm script も、追跡している wrangler.*.jsonc を直接渡さない", () => {
    const direct = Object.entries(scripts).filter(([, cmd]) => /wrangler\.(delivery|admin)\.jsonc/.test(cmd));
    expect(direct).toEqual([]);
    for (const name of ["delivery:dev", "admin:dev", "delivery:migrate:local", "admin:migrate:local"]) {
      expect(scripts[name], name).toContain("scripts/wrangler-run.mjs");
    }
  });
  it("✅ 通る例: dev は通り、--remote 付きの dev は断る", () => {
    expect(wranglerRunProblems({ target: "delivery", args: ["dev"] })).toEqual([]);
    expect(wranglerRunProblems({ target: "admin", args: ["d1", "migrations", "apply", "adpop", "--local"] })).toEqual([]);
  });
  it.each([["--remote"], ["-r"], ["--remote=true"], ["-ar"], ["--port", "8799", "-r"]])("🔴 落ちる例: dev に %s(リモート dev)は渡せない(admin・delivery の両方)", (...extra) => {
    for (const target of ["admin", "delivery"]) {
      expect(wranglerRunProblems({ target, args: ["dev", ...extra] }).length, `${target} ${extra.join(" ")}`).toBeGreaterThan(0);
    }
  });
  it("✅ 通る例: --port など、リモートではない引数は通る", () => {
    expect(wranglerRunProblems({ target: "admin", args: ["dev", "--port", "8799"] })).toEqual([]);
  });
});

describe("ローカル確認用の配信元は deploy の保証を緩めない", () => {
  it("✅ 通る例: localhost / 127.0.0.1 のポート付き http だけがローカルの配信元", () => {
    expect(isLocalOrigin("http://localhost:8787")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:8799")).toBe(true);
    expect(localDeliveryOrigin({})).toBe("http://localhost:8787");
    expect(localDeliveryOrigin({ ADPOP_LOCAL_DELIVERY_ORIGIN: "http://localhost:8799/" })).toBe("http://localhost:8799");
  });
  it.each(["https://localhost:8787", "http://localhost", "http://localhost:8787/x", "http://evil.example.net:8787", "http://localhost.evil.net:80", "http://*.localhost:1", ""])(
    "🔴 落ちる例: %s はローカルの配信元ではない(CSP の img-src にも入らない)",
    (value) => {
      expect(isLocalOrigin(value)).toBe(false);
      expect(isSafeOrigin(value)).toBe(value.startsWith("https://") && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value));
      expect(() => localDeliveryOrigin({ ADPOP_LOCAL_DELIVERY_ORIGIN: value || "x" })).toThrow();
    },
  );
  it("🔴 落ちる例: deploy 前の検査は、ローカルの URL を配信ホストと一致しないとして止める", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: "http://localhost:8787", expectedOrigin: "https://adpop.ci.test" }).length).toBeGreaterThan(0);
  });
  it.each([["admin", ADMIN_WRANGLER_PATH], ["delivery", DELIVERY_WRANGLER_PATH]])("🔴 ローカル用の設定(%s)に、本番を指せる値(deploy.local.json のホスト・D1 の id・本番の Worker 名・routes)が1つも入らない", (target, trackedPath) => {
    const tracked = readWranglerConfig(trackedPath);
    // deploy 用に重ねた設定(本番値入り)を作ってから、ローカル用の設定がそれらを含まないことを見る
    const deployConfig = applyLocalOverride(tracked, { host: GOOD.adminHost, databaseId: GOOD.databaseId });
    expect(JSON.stringify(deployConfig)).toContain(GOOD.databaseId);
    const local = localWranglerConfig(tracked, target) as { name: string; routes?: unknown; d1_databases: Array<{ database_id: string }>; r2_buckets: Array<{ bucket_name: string }> };
    const text = JSON.stringify(local);
    for (const secret of [GOOD.adminHost, GOOD.deliveryHost, GOOD.databaseId, PLACEHOLDER_ADMIN_HOST, PLACEHOLDER_DELIVERY_HOST, PLACEHOLDER_DATABASE_ID]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(local.routes).toBeUndefined();
    expect(local.name).toBe(localWorkerName(target));
    expect(local.name).not.toBe((tracked as { name: string }).name);
    expect(local.d1_databases.map((d) => d.database_id)).toEqual([LOCAL_DATABASE_ID]);
    expect(local.r2_buckets.map((b) => b.bucket_name)).not.toEqual((tracked as { r2_buckets: Array<{ bucket_name: string }> }).r2_buckets.map((b) => b.bucket_name));
    expect((tracked as { build: { command: string } }).build.command).toContain("check-custom-domain");
    expect(wranglerRunProblems({ target, args: ["deploy"] }).length).toBeGreaterThan(0);
  });
  it("ローカル用の設定を使う呼び方は dev と、--remote の無い d1 --local だけ", () => {
    expect(usesLocalConfig(["dev"])).toBe(true);
    expect(usesLocalConfig(["d1", "migrations", "apply", "adpop", "--local"])).toBe(true);
    expect(usesLocalConfig(["d1", "migrations", "apply", "adpop", "--remote"])).toBe(false);
    expect(usesLocalConfig(["d1", "migrations", "apply", "adpop", "--local", "--remote"])).toBe(false);
    expect(usesLocalConfig(["d1", "time-travel", "info", "adpop"])).toBe(false);
    expect(usesLocalConfig(["secret", "put", "X"])).toBe(false);
  });
});
