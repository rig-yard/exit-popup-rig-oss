// @vitest-environment node
//
// 配信の2つの口(src/lib/data/delivery.ts)を、**実物のローカル D1** で測る。
// 旧版の検査のうち **D1 でも意味があるもの**を移し、同じ入力に同じ理由で断ることを固定する。
// ⚠ 移していないもの: ロールと権限の検査(D1 にロールが無い)/ 許可ドメインの配列の NULL(配列をやめて行にした)。
// ⚠ 表示 ID の形の違いは delivery.ts の冒頭。
//
// 🔴 **この束がいちばん守りたいもの**:
//   ① **fail-closed**: サイトキー・Origin・許可ドメイン・稼働中・配れるパターンのどれか1つでも欠けたら何も返さない
//   ② **返す情報が最小**: 内部 id・owner_id・他サイトの情報を1バイトも返さない
//   ③ **page_url は origin + path だけ**(投入側が削ってから入れる)
//   ④ **所有者を呼び出し側から指定できない**
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { recordEvent, siteConfig } from "../src/lib/data/delivery";
import { openTestD1, OWNER_A, OWNER_B, OWNER_C, OWNER_D, type TestD1 } from "./helpers/d1";

const ORIGIN_A = "https://lp.example.com";
const ORIGIN_B = "https://other.example.com";

let t: TestD1;
let db: D1Database;

const ref = {
  siteIdA: "",
  siteKeyA: "",
  siteKeyB: "",
  siteKeyEmptyOrigins: "",
  siteKeyNoActive: "",
  popupIdA: "",
  popupKeyA: "",
  popupKeyB: "",
  variantIdA: "",
  variantIdA2: "",
  variantKeyA: "",
  variantKeyA2: "",
  variantKeyB: "",
};

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

async function siteKeyOf(siteId: string): Promise<string> {
  return (await db.prepare("select site_key from sites where id = ?1").bind(siteId).first<{ site_key: string }>())!
    .site_key;
}
async function popupKeyOf(popupId: string): Promise<string> {
  return (await db.prepare("select public_key from popups where id = ?1").bind(popupId).first<{ public_key: string }>())!
    .public_key;
}
async function variantKeyOf(variantId: string): Promise<string> {
  return (await db.prepare("select public_key from variants where id = ?1").bind(variantId).first<{ public_key: string }>())!
    .public_key;
}

const text = (headline: string) => ({ headline, body: "", buttonLabel: "", imageAlt: "" });

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
  value(await admin.ensureOwner(db, OWNER_B));
  // 🔴 1インストール=1サイト(所有者ごとに1つ)。この束は「許可ドメインが空」「稼働中ポップが無い」の
  // サイトを A のサイトと同時に持たせたいので、別の所有者(OWNER_C/D)にする。
  // この束の検査は所有者の分離ではなく配信の fail-closed(どのサイトで落ちるか)を見ているので、
  // 所有者が同じかどうかには依らない。
  value(await admin.ensureOwner(db, OWNER_C));
  value(await admin.ensureOwner(db, OWNER_D));

  ref.siteIdA = value(await admin.createSite(db, OWNER_A, { name: "A の LP", allowedOrigins: [ORIGIN_A] })).id;
  const empty = value(await admin.createSite(db, OWNER_C, { name: "許可空", allowedOrigins: [] })).id;
  const noActive = value(await admin.createSite(db, OWNER_D, { name: "稼働なし", allowedOrigins: [ORIGIN_A] })).id;
  const siteB = value(await admin.createSite(db, OWNER_B, { name: "B の LP", allowedOrigins: [ORIGIN_B] })).id;

  ref.popupIdA = value(await admin.createPopup(db, OWNER_A, ref.siteIdA, { name: "A" })).id;
  const popupEmpty = value(await admin.createPopup(db, OWNER_C, empty, { name: "許可空" })).id;
  value(await admin.createPopup(db, OWNER_D, noActive, { name: "下書き" }));
  const popupB = value(await admin.createPopup(db, OWNER_B, siteB, { name: "B" })).id;

  ref.variantIdA = value(
    await admin.createVariant(db, OWNER_A, ref.popupIdA, {
      kind: "text",
      content: text("まだ間に合います"),
      destinationUrl: "https://offer.example.com/a",
    }),
  ).id;
  ref.variantIdA2 = value(
    await admin.createVariant(db, OWNER_A, ref.popupIdA, {
      kind: "text",
      content: text("もう1つの案"),
      destinationUrl: "https://offer.example.com/b",
    }),
  ).id;
  // 重みを使った割り当ては未実装。ここでは配信が重みをそのまま返すことだけを見る
  await db.prepare("update variants set weight = 60, content = ?2 where id = ?1")
    .bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
  await db.prepare("update variants set weight = 40 where id = ?1").bind(ref.variantIdA2).run();
  value(
    await admin.createVariant(db, OWNER_C, popupEmpty, {
      kind: "text",
      content: text("x"),
      destinationUrl: "https://offer.example.com/x",
    }),
  );
  const variantB = value(
    await admin.createVariant(db, OWNER_B, popupB, {
      kind: "text",
      content: text("B"),
      destinationUrl: "https://offer.example.com/bb",
    }),
  ).id;

  value(await admin.activatePopup(db, OWNER_A, ref.popupIdA));
  // 許可ドメインが空のサイトでも「稼働中」にはできる(配信はされない)
  await db.prepare("update popups set status = 'active' where id = ?1").bind(popupEmpty).run();
  value(await admin.activatePopup(db, OWNER_B, popupB));

  ref.siteKeyA = await siteKeyOf(ref.siteIdA);
  ref.siteKeyB = await siteKeyOf(siteB);
  ref.siteKeyEmptyOrigins = await siteKeyOf(empty);
  ref.siteKeyNoActive = await siteKeyOf(noActive);
  ref.popupKeyA = await popupKeyOf(ref.popupIdA);
  ref.popupKeyB = await popupKeyOf(popupB);
  ref.variantKeyA = await variantKeyOf(ref.variantIdA);
  ref.variantKeyA2 = await variantKeyOf(ref.variantIdA2);
  ref.variantKeyB = await variantKeyOf(variantB);
});

afterAll(async () => {
  await t?.dispose();
});

const config = (siteKey: string, origin: string) => siteConfig({ DB: db }, siteKey, origin);
const record = (siteKey: string, origin: string, event: Record<string, unknown>) =>
  recordEvent({ DB: db }, siteKey, origin, event);

describe("配信: siteConfig", () => {
  it("✅ 許可ドメインから引くと、いま有効なポップの設定が返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.v).toBe(1);
    expect(c.popup.key).toBe(ref.popupKeyA);
    expect(c.popup.minDisplayDelaySeconds).toBe(3);
    expect(c.popup.frequency).toEqual({ suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 });
  });

  it("🔴 内部 id・owner_id・他サイトの情報を1バイトも返さない", async () => {
    const raw = JSON.stringify(await config(ref.siteKeyA, ORIGIN_A));
    for (const [label, secret] of [
      ["owner_id", OWNER_A],
      ["site の内部 id", ref.siteIdA],
      ["popup の内部 id", ref.popupIdA],
      ["variant の内部 id", ref.variantIdA],
      ["他サイトの公開キー", ref.siteKeyB],
      ["他サイトのポップ", ref.popupKeyB],
      ["他サイトのバリアント", ref.variantKeyB],
    ] as const) {
      expect(raw.includes(secret), `${label} が配信の応答に混ざっている`).toBe(false);
    }
    expect(raw).not.toMatch(/owner/i);
  });

  it("有効なトリガだけが、既定値のまま、旧版と同じ順で返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.popup.triggers).toEqual([
      { kind: "back", threshold: null },
      { kind: "exit_intent", threshold: null },
    ]);
  });

  it("バリアントは重みと中身つきで、決定的な順序で返る(割り当ては未実装)", async () => {
    const first = (await config(ref.siteKeyA, ORIGIN_A))!;
    const second = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(first.popup.variants.map((v) => v.key).sort()).toEqual([ref.variantKeyA, ref.variantKeyA2].sort());
    expect(second.popup.variants.map((v) => v.key)).toEqual(first.popup.variants.map((v) => v.key));
    expect(first.popup.variants.find((v) => v.key === ref.variantKeyA)).toEqual({
      key: ref.variantKeyA,
      kind: "text",
      weight: 60,
      content: { headline: "まだ間に合います" },
      destinationUrl: "https://offer.example.com/a",
      mobile: { kind: "text", content: { headline: "まだ間に合います" } },
    });
  });

  describe("🔴 fail-closed(1つでも合わなければ null)", () => {
    it.each([
      ["許可していない Origin", () => config(ref.siteKeyA, ORIGIN_B)],
      ["Origin の形が違う", () => config(ref.siteKeyA, "https://lp.example.com/path")],
      ["Origin が空文字", () => config(ref.siteKeyA, "")],
      ["Origin の大文字違い(許可ドメインは小文字で保存)", () => config(ref.siteKeyA, "https://LP.example.com")],
      ["サイトキーの形が違う", () => config("not-a-site-key", ORIGIN_A)],
      ["実在しないサイトキー", () => config("0".repeat(32), ORIGIN_A)],
      ["許可ドメインが空のサイト", () => config(ref.siteKeyEmptyOrigins, ORIGIN_A)],
      ["稼働中のポップが無いサイト", () => config(ref.siteKeyNoActive, ORIGIN_A)],
    ])("%s → null", async (_label, run) => {
      expect(await run()).toBeNull();
    });

    it("🔴 配れるパターンが1つも無いポップは配らない", async () => {
      await db.prepare("update variants set archived_at = '2026-01-01T00:00:00.000Z' where popup_id = ?1").bind(ref.popupIdA).run();
      try {
        expect(await config(ref.siteKeyA, ORIGIN_A)).toBeNull();
      } finally {
        await db.prepare("update variants set archived_at = null where popup_id = ?1").bind(ref.popupIdA).run();
      }
    });
  });

  it.each([
    ["アーカイブしたパターン", "update variants set archived_at = '2026-01-01T00:00:00.000Z' where id = ?1", "update variants set archived_at = null where id = ?1"],
    [
      "画像型だが画像が未設定のパターン(今も配らない。配信の壊れたポップを作らないため)",
      "update variants set kind = 'image' where id = ?1",
      "update variants set kind = 'text' where id = ?1",
    ],
    ["🕐 chatbot のパターン(v1.1)", "update variants set kind = 'chatbot' where id = ?1", "update variants set kind = 'text' where id = ?1"],
  ])("🔴 %s は配らない", async (_label, breakSql, restoreSql) => {
    await db.prepare(breakSql).bind(ref.variantIdA2).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.map((v) => v.key)).toEqual([ref.variantKeyA]);
    } finally {
      await db.prepare(restoreSql).bind(ref.variantIdA2).run();
    }
  });

  it("✅ 画像が設定された画像型パターンは配る(配信と稼働の切り替えが同じ定義を使う)", async () => {
    const key = `images/${"d".repeat(32)}.png`;
    await db
      .prepare("update variants set kind = 'image', content = ?2 where id = ?1")
      .bind(ref.variantIdA2, JSON.stringify({ headline: "もう1つの案", body: "", buttonLabel: "", imageAlt: "説明", imageKey: key }))
      .run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.map((v) => v.key).sort()).toEqual([ref.variantKeyA, ref.variantKeyA2].sort());
      const variant = c.popup.variants.find((v) => v.key === ref.variantKeyA2)!;
      expect(variant.kind).toBe("image");
      expect(variant.content).toEqual({ headline: "もう1つの案", body: "", buttonLabel: "", imageAlt: "説明", imageKey: key });
    } finally {
      await db
        .prepare("update variants set kind = 'text', content = ?2 where id = ?1")
        .bind(ref.variantIdA2, JSON.stringify({ headline: "もう1つの案", body: "", buttonLabel: "" }))
        .run();
    }
  });

  it("🔴 `content` に無関係な鍵を入れても、配信の応答には出ない(出てよい鍵の集合ちょうど。imageKey/imageAlt は 後から足した)", async () => {
    await db.prepare("update variants set content = ?2 where id = ?1").bind(
      ref.variantIdA,
      JSON.stringify({
        headline: "見出し",
        body: "本文",
        buttonLabel: "押す",
        imageAlt: "説明",
        imageKey: `images/${"a".repeat(32)}.png`,
        internalNote: "社外秘",
        ownerEmail: "a@example.test",
      }),
    ).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      const variant = c.popup.variants.find((v) => v.key === ref.variantKeyA)!;
      expect(Object.keys(variant.content).sort()).toEqual(["body", "buttonLabel", "headline", "imageAlt", "imageKey"]);
      expect(JSON.stringify(c)).not.toContain("社外秘");
      expect(JSON.stringify(c)).not.toContain("a@example.test");
    } finally {
      await db.prepare("update variants set content = ?2 where id = ?1").bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
    }
  });

  it("⚠ 空の `content` は空のまま返る(null を詰めない)", async () => {
    await db.prepare("update variants set content = '{}' where id = ?1").bind(ref.variantIdA).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.find((v) => v.key === ref.variantKeyA)!.content).toEqual({});
    } finally {
      await db.prepare("update variants set content = ?2 where id = ?1").bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
    }
  });
});

/*
  配信の `popup.mobile` / `variants[].mobile`(表示設定はサイト単位)。
  🔴 ここは**状態**を測る:
    「PC と同じ(same_as_pc)の間は、スマホの値が PC の値とちょうど同じ」(移行直後に動きが変わらない証明)
    「個別に設定した(custom)分だけがスマホの値に反映され、PC は変わらない」の両方を実物の D1 で確かめる。
  ⚠ きっかけ・頻度(サイト単位)・デザイン(ポップごと)は別々に custom にできるので、**それぞれ単独で**撃つ。
  ⚠ `popups` の頻度の列・`popup_triggers`・0004 の `popup_mobile_display` / `popup_mobile_triggers` は
    **凍結**(凍結した表・列の扱い)——値の出どころは `site_display_settings` / `site_display_triggers` だけ。
*/
describe("配信: スマホ用に解決した値(popup.mobile / variants[].mobile)", () => {
  // 🔴 1インストール=1サイト(所有者ごとに1つ)。この describe は1回のテストにつき新しい
  // サイトを1つ作り直すので、既存の A/B/C/D(ファイル全体で使っている)とは別の、専用の所有者を使い、
  // 呼ぶたびに前回ぶんを消してから作る。
  const MOBILE_OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  async function freshDeliverablePopup(): Promise<{ siteKey: string; siteId: string; popupId: string; variantId: string }> {
    await db.prepare("delete from owners where id = ?1").bind(MOBILE_OWNER).run();
    value(await admin.ensureOwner(db, MOBILE_OWNER));
    const siteId = value(await admin.createSite(db, MOBILE_OWNER, { name: "mobile 配信", allowedOrigins: [ORIGIN_A] })).id;
    const popupId = value(await admin.createPopup(db, MOBILE_OWNER, siteId, { name: "p" })).id;
    const variantId = value(
      await admin.createVariant(db, MOBILE_OWNER, popupId, {
        kind: "text",
        content: text("見出し"),
        destinationUrl: "https://offer.example.com/m",
      }),
    ).id;
    value(await admin.activatePopup(db, MOBILE_OWNER, popupId));
    return { siteKey: await siteKeyOf(siteId), siteId, popupId, variantId };
  }

  it("🔴 全部 same_as_pc の間は、popup.mobile と variants[].mobile が PC の値とちょうど同じ(移行直後に動きが変わらない証明)", async () => {
    const { siteKey } = await freshDeliverablePopup();
    const c = (await config(siteKey, ORIGIN_A))!;
    expect(c.popup.mobile).toEqual({
      minDisplayDelaySeconds: c.popup.minDisplayDelaySeconds,
      frequency: c.popup.frequency,
      triggers: c.popup.triggers,
    });
    expect(c.popup.variants).toHaveLength(1);
    const variant = c.popup.variants[0];
    expect(variant.mobile).toEqual({ kind: variant.kind, content: variant.content });
  });

  it("🔴 きっかけだけを custom にすると、popup.mobile.triggers だけがスマホの値になる(頻度・デザインは PC のまま)", async () => {
    const { siteKey, siteId } = await freshDeliverablePopup();
    value(await admin.setSiteTriggersMode(db, MOBILE_OWNER, siteId, "custom"));
    value(await admin.setSiteTriggerEnabled(db, MOBILE_OWNER, siteId, "mobile", "scroll", true));

    const c = (await config(siteKey, ORIGIN_A))!;
    // PC のきっかけ(既定: back・exit_intent)は変わらない
    expect(c.popup.triggers.map((t) => t.kind).sort()).toEqual(["back", "exit_intent"]);
    // スマホのきっかけは scroll が加わる(PC には出ない)
    expect(c.popup.mobile.triggers.map((t) => t.kind)).toContain("scroll");
    expect(c.popup.triggers.map((t) => t.kind)).not.toContain("scroll");
    // 頻度・デザインは引き続き PC と同じ
    expect(c.popup.mobile.frequency).toEqual(c.popup.frequency);
    expect(c.popup.mobile.minDisplayDelaySeconds).toBe(c.popup.minDisplayDelaySeconds);
    const variant = c.popup.variants.find((v) => v.key !== undefined)!;
    expect(variant.mobile).toEqual({ kind: variant.kind, content: variant.content });
  });

  it("🔴 頻度だけを custom にすると、popup.mobile.frequency / minDisplayDelaySeconds だけがスマホの値になる(きっかけは PC のまま)", async () => {
    const { siteKey, siteId } = await freshDeliverablePopup();
    value(await admin.setSiteFrequencyMode(db, MOBILE_OWNER, siteId, "custom"));
    value(
      await admin.updateSiteFrequency(db, MOBILE_OWNER, siteId, "mobile", {
        suppressDays: 1,
        sessionImpressions: 9,
        postConversionDays: 2,
        minDisplayDelaySeconds: 11,
      }),
    );

    const c = (await config(siteKey, ORIGIN_A))!;
    expect(c.popup.frequency).toEqual({ suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 }); // PC は既定値のまま
    expect(c.popup.mobile.frequency).toEqual({ suppressDays: 1, sessionImpressions: 9, postConversionDays: 2 });
    expect(c.popup.minDisplayDelaySeconds).toBe(3);
    expect(c.popup.mobile.minDisplayDelaySeconds).toBe(11);
    expect(c.popup.mobile.triggers).toEqual(c.popup.triggers); // きっかけは same_as_pc のまま
  });

  it("🔴 サイトの PC(desktop)の頻度を直すと、同じサイトの稼働中ポップの応答にも反映される(表示設定はサイト単位)", async () => {
    const { siteKey, siteId } = await freshDeliverablePopup();
    value(
      await admin.updateSiteFrequency(db, MOBILE_OWNER, siteId, "desktop", {
        suppressDays: 2,
        sessionImpressions: 3,
        postConversionDays: 4,
        minDisplayDelaySeconds: 5,
      }),
    );
    const c = (await config(siteKey, ORIGIN_A))!;
    expect(c.popup.frequency).toEqual({ suppressDays: 2, sessionImpressions: 3, postConversionDays: 4 });
    expect(c.popup.minDisplayDelaySeconds).toBe(5);
    expect(c.popup.mobile.frequency).toEqual(c.popup.frequency); // mobile は same_as_pc のまま追随する
  });

  it("🔴 デザインだけを custom にすると、該当パターンの variants[].mobile だけがスマホの見た目になる(PC の content は変わらない)", async () => {
    const { siteKey, variantId } = await freshDeliverablePopup();
    value(await admin.setMobileVariantDesignCustom(db, MOBILE_OWNER, variantId, null));
    value(
      await admin.updateMobileVariantDesign(db, MOBILE_OWNER, variantId, {
        kind: "text",
        content: { headline: "スマホ専用の見出し", body: "", buttonLabel: "", imageAlt: "" },
      }),
    );

    const c = (await config(siteKey, ORIGIN_A))!;
    const variant = c.popup.variants[0];
    expect(variant.content).toEqual({ headline: "見出し", body: "", buttonLabel: "", imageAlt: "" }); // PC は変わらない
    expect(variant.mobile).toEqual({ kind: "text", content: { headline: "スマホ専用の見出し", body: "", buttonLabel: "", imageAlt: "" } });
  });

  it("⚠ `site_display_settings` の mobile 行が無い(移行漏れ等の想定外)ときも same_as_pc と同じ扱いになる(fail-safe)", async () => {
    const { siteKey, siteId } = await freshDeliverablePopup();
    await db.prepare("delete from site_display_settings where site_id = ?1 and device = 'mobile'").bind(siteId).run();
    const c = (await config(siteKey, ORIGIN_A))!;
    expect(c.popup.mobile).toEqual({
      minDisplayDelaySeconds: c.popup.minDisplayDelaySeconds,
      frequency: c.popup.frequency,
      triggers: c.popup.triggers,
    });
  });

  it("⚠ `site_display_settings` の desktop 行が無い(想定外の不整合)ときは配信しない(fail-closed。値の出どころが無い)", async () => {
    const { siteKey, siteId } = await freshDeliverablePopup();
    await db.prepare("delete from site_display_settings where site_id = ?1 and device = 'desktop'").bind(siteId).run();
    expect(await config(siteKey, ORIGIN_A)).toBeNull();
  });

  it("🔴 凍結した `popups` の頻度の列・`popup_triggers` を直接書き換えても、配信の応答は1ミリも変わらない(読んでいないことの状態での証明)", async () => {
    const { siteKey, popupId } = await freshDeliverablePopup();
    const before = (await config(siteKey, ORIGIN_A))!;
    await db
      .prepare(`update popups set suppress_days = 999, session_impressions = 999, post_conversion_days = 999, min_display_delay_seconds = 999 where id = ?1`)
      .bind(popupId)
      .run();
    await db.prepare(`update popup_triggers set enabled = 1, threshold = 12345 where popup_id = ?1`).bind(popupId).run();
    const after = (await config(siteKey, ORIGIN_A))!;
    expect(after).toEqual(before);
  });

  it("🔴 アーカイブ済みのパターンのスマホ用上書きは読まない(配信できるパターンの数だけ読む。no-store で毎回読む問い合わせなので行数が無制限に増えない)", async () => {
    const { siteKey, popupId, variantId } = await freshDeliverablePopup();
    // 配信できる(アーカイブしていない)パターンは1つ(freshDeliverablePopup が作った variantId)のまま、
    // アーカイブ済みのパターンを4つ足す。それぞれにスマホ用の個別デザインを入れる(=variant_mobile_designs に行がある)。
    for (let i = 0; i < 4; i += 1) {
      const archivedId = value(
        await admin.createVariant(db, MOBILE_OWNER, popupId, {
          kind: "text",
          content: text(`archived-${i}`),
          destinationUrl: "https://offer.example.com/archived",
        }),
      ).id;
      value(await admin.setMobileVariantDesignCustom(db, MOBILE_OWNER, archivedId, null));
      await db.prepare(`update variants set archived_at = '2026-01-01T00:00:00.000Z' where id = ?1`).bind(archivedId).run();
    }
    value(await admin.setMobileVariantDesignCustom(db, MOBILE_OWNER, variantId, null)); // 配信できる方にもスマホの個別デザインを入れる

    // 🔴 この popup の variant_mobile_designs は、配信できる1件+アーカイブ済み4件の**ちょうど5行**ある
    //   (行を揃えるトリガで、パターンを作った瞬間に必ず1行入るため)。
    const totalDesignRows = (
      await db
        .prepare(`select count(*) as c from variant_mobile_designs vmd join variants v on v.id = vmd.variant_id where v.popup_id = ?1`)
        .bind(popupId)
        .first<{ c: number }>()
    )!.c;
    expect(totalDesignRows, "テストの前提(5行)が崩れている").toBe(5);

    // 🔴 実物の db.batch() を横取りして、配信が実際に読んだ行数を直接測る(応答の中身だけでは、
    //   配信できないパターンの分まで読んでいても見分けが付かないため)。
    let mobileDesignRowsRead: number | null = null;
    const spyingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: Parameters<D1Database["batch"]>[0]) => {
            const results = await target.batch(statements);
            // 5番目(index 4)がスマホ用デザインの問い合わせ(src/lib/data/delivery.ts の並びと)
            mobileDesignRowsRead = (results[4]?.results as unknown[] | undefined)?.length ?? null;
            return results;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const c = (await siteConfig({ DB: spyingDb }, siteKey, ORIGIN_A))!;
    expect(c.popup.variants).toHaveLength(1); // 応答自体は元から正しい(配信できる1件だけ)

    // 🔴 本題: 実際に読んだ行数は、配信できるパターンの数(1)と同じで、アーカイブ済みの分(4)を含まない
    expect(mobileDesignRowsRead, "アーカイブ済みのパターンの行まで読んでいる").toBe(1);
  });
});

describe("投入: recordEvent", () => {
  let counter = 0;
  const nextImpression = () => {
    counter += 1;
    return `aaaaaaaa-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  };
  const base = () => ({
    popupKey: ref.popupKeyA,
    variantKey: ref.variantKeyA,
    device: "mobile",
    visitorHash: "0123456789abcdef0123456789abcdef",
  });
  const storedPageUrl = async (impressionId: string) =>
    (
      await db
        .prepare("select page_url from events where impression_id = ?1 and kind = 'impression'")
        .bind(impressionId)
        .first<{ page_url: string | null }>()
    )?.page_url ?? null;

  it("✅ 表示イベントが入る", async () => {
    const impressionId = nextImpression();
    expect(
      await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId,
        pageUrl: `${ORIGIN_A}/lp/a`,
      }),
    ).toEqual({ ok: true, stored: true });
    expect(await storedPageUrl(impressionId)).toBe(`${ORIGIN_A}/lp/a`);
  });

  it("🔴 page_url は query と fragment を削ってから入る", async () => {
    for (const [sent, expected] of [
      [`${ORIGIN_A}/lp?email=taro%40example.com`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp?utm_source=x#anchor`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp#anchor?x=1`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}?a=1`, ORIGIN_A],
      [`${ORIGIN_A}/@handle`, `${ORIGIN_A}/@handle`],
    ] as const) {
      const impressionId = nextImpression();
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId,
        pageUrl: sent,
      });
      expect(r.ok, `${sent} が断られた`).toBe(true);
      expect(await storedPageUrl(impressionId), `${sent} の削り方`).toBe(expected);
    }
  });

  it("🔴 削っても形が合わない URL は断る(黙って null にして通さない)", async () => {
    for (const bad of [
      "https://taro@example.com/path",
      "lp.example.com/a",
      "https://lp.example.com/a b",
      "javascript:alert(1)",
    ]) {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId: nextImpression(),
        pageUrl: bad,
      });
      expect(r, `${bad} が通った`).toEqual({ ok: false, reason: "pageUrl" });
    }
  });

  it("🔴 表示と閉じるは同じ impression_id で二重に増えない(stored=false は断りではない)", async () => {
    const impressionId = nextImpression();
    const impression = { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId };
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: false });
    const close = { ...base(), kind: "close", impressionId, closeReason: "esc" };
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: false });
    const c = await db.prepare("select count(*) as c from events where impression_id = ?1").bind(impressionId).first<{ c: number }>();
    expect(c?.c).toBe(2);
  });

  it("クリックは同じ表示に何度でも入る(CTR はダッシュボードで畳む)", async () => {
    const impressionId = nextImpression();
    await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId });
    for (let i = 0; i < 2; i += 1) {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "click", impressionId })).toEqual({
        ok: true,
        stored: true,
      });
    }
  });

  it("✅ 発火と抑制はパターンも表示 ID も無しで入る", async () => {
    for (const kind of ["fire", "suppressed"]) {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "desktop", kind, triggerKind: "exit_intent" }),
        kind,
      ).toEqual({ ok: true, stored: true });
    }
  });

  describe("🔴 断り(どの理由で断ったかまで固定する)", () => {
    it.each([
      // 🔴 サイトと Origin の断りは1つの理由(サイトキーの実在を判別させない)
      ["サイトキーの形", () => record("not-a-key", ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["実在しないサイト", () => record("0".repeat(32), ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["許可していない Origin", () => record(ref.siteKeyA, ORIGIN_B, { ...base(), kind: "fire" }), "not_allowed"],
      ["Origin の形", () => record(ref.siteKeyA, "lp.example.com", { ...base(), kind: "fire" }), "not_allowed"],
      ["許可ドメインが空のサイト", () => record(ref.siteKeyEmptyOrigins, ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["実在しないポップ", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), popupKey: "0".repeat(32), kind: "fire" }), "popup"],
      ["ポップの指定が無い", () => record(ref.siteKeyA, ORIGIN_A, { device: "mobile", kind: "fire" }), "popup"],
      ["端末が2値でない", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), device: "tablet", kind: "fire" }), "shape"],
      ["知らない kind", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "unknown" }), "kind"],
      ["匿名IDの形", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), visitorHash: "taro@example.com", kind: "fire" }), "visitorHash"],
      [
        "表示 ID が uuid でない",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId: "not-a-uuid" }),
        "impressionId",
      ],
      [
        "表示なのにトリガ種別が無い",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", impressionId: "aaaaaaaa-9999-0000-0000-000000000001" }),
        "shape",
      ],
      [
        "閉じるなのに理由が無い",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "close", impressionId: "aaaaaaaa-9999-0000-0000-000000000002" }),
        "shape",
      ],
      ["知らないトリガ種別", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "fire", triggerKind: "hover" }), "shape"],
      ["イベントが JSON のオブジェクトでない", () => record(ref.siteKeyA, ORIGIN_A, "文字列" as never), "event"],
    ])("%s → 断る", async (_label, run, reason) => {
      expect(await run()).toEqual({ ok: false, reason });
    });

    it("🔴 CV(conversion)はこの口では受けない(CV 計測は別の入口にする予定で、未実装)", async () => {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "conversion" })).toEqual({ ok: false, reason: "kind" });
    });

    it("🔴 値が JSON の文字列でなければ断る(数値や真偽値を文字列として通さない)", async () => {
      for (const bad of [
        { visitorHash: 12345678901234567890123456789012 },
        { popupKey: 123 },
        { kind: ["fire"] },
        { device: null },
        { pageUrl: { a: 1 } },
      ]) {
        expect(
          await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", ...bad }),
          `${JSON.stringify(bad)} が通った`,
        ).toEqual({ ok: false, reason: "types" });
      }
    });

    it("本文が 4KB を超えたら断る / ✅ 4KB 以内なら通る", async () => {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", pageUrl: `${ORIGIN_A}/${"a".repeat(5000)}` }),
      ).toEqual({ ok: false, reason: "too_large" });
      expect(
        (await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", pageUrl: `${ORIGIN_A}/${"a".repeat(1000)}` })).ok,
      ).toBe(true);
    });
  });

  describe("🔴 他人のサイトへ書けない", () => {
    it("他サイトのポップの識別子を渡しても、そのサイトの行にならない", async () => {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), popupKey: ref.popupKeyB, kind: "fire" })).toEqual({
        ok: false,
        reason: "popup",
      });
    });

    it("他ポップのパターンの識別子を渡しても解決しない", async () => {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, {
          ...base(),
          variantKey: ref.variantKeyB,
          kind: "impression",
          triggerKind: "exit_intent",
          impressionId: nextImpression(),
        }),
      ).toEqual({ ok: false, reason: "variant" });
    });

    it("✅ 入った行は、全部そのサイトの owner のもの(所有者を呼び出し側から指定できない)", async () => {
      await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "fire", ownerId: OWNER_B, siteId: "x" });
      const rows = await db.prepare("select distinct owner_id, site_id from events").all<{ owner_id: string; site_id: string }>();
      expect(rows.results.length, "1行も入っていない = 何も測っていない").toBeGreaterThan(0);
      for (const row of rows.results) {
        expect(row.owner_id).toBe(OWNER_A);
        expect(row.site_id).toBe(ref.siteIdA);
      }
    });
  });

  it("🔴 重複排除はサイトの中だけ(他サイトが同じ表示 ID を先に入れても、こちらは落ちない)", async () => {
    const shared = "dddddddd-0000-0000-0000-000000000001";
    const mine = { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId: shared };
    expect(await record(ref.siteKeyA, ORIGIN_A, mine)).toEqual({ ok: true, stored: true });
    expect(
      await record(ref.siteKeyB, ORIGIN_B, {
        popupKey: ref.popupKeyB,
        variantKey: ref.variantKeyB,
        device: "mobile",
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId: shared,
      }),
    ).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, mine)).toEqual({ ok: true, stored: false });
  });
});
