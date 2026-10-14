// @vitest-environment node
//
// PC / スマホ別の表示設定・デザイン。画面も配信も変えない回(0004)。
// 🔴 ここは**状態**を測る: 「書いた形跡」ではなく「移行後に全ポップ・全パターンが PC と同じ値で揃うこと」
//   「個別に設定したあとは PC を直してもスマホに効かないこと」「画像が PC とスマホで同じキーを共有しないこと」
//   「削除でスマホの画像も R2 から消えること」を実際のローカル D1・R2 で確かめる。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import * as images from "../src/lib/data/images";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";
import { r2Snapshot } from "./helpers/r2";

let t: TestD1;
let db: D1Database;

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);
const TINY_PNG_2 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (ch) => ch.charCodeAt(0),
);

// 🔴 サイトは1つを使い回す(サイトの上限は所有者あたり20。この束のテスト数がそれを超えるため。
//   どのテストもサイトをまたいだ分離は見ていない=使い回しても意味が変わらない)。
let sharedSiteId: string | null = null;
async function newSite(): Promise<string> {
  if (sharedSiteId === null) sharedSiteId = value(await admin.createSite(db, OWNER_A, { name: "mobile", allowedOrigins: [] })).id;
  return sharedSiteId;
}
async function newPopup(siteId: string): Promise<string> {
  return value(await admin.createPopup(db, OWNER_A, siteId, { name: "p" })).id;
}
const textInput = (headline: string): admin.VariantInput => ({
  kind: "text",
  content: { headline, body: "", buttonLabel: "", imageAlt: "" },
  destinationUrl: "https://offer.example.com/",
});
const imageInput = (): admin.VariantInput => ({
  kind: "image",
  content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" },
  destinationUrl: "https://offer.example.com/",
});

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
});
afterAll(async () => {
  await t?.dispose();
});

/** `images.ts` の関数が受け取るバインドの入れ物(`TestD1` はそのままの形では渡せない)。 */
function env(): { DB: D1Database; IMAGES: TestD1["images"] } {
  return { DB: db, IMAGES: t.images };
}

describe("行を揃えるトリガ(ポップ・パターンを作った瞬間)", () => {
  /*
    🔴 表示設定(きっかけ・頻度)はサイト単位になり、`popup_mobile_display` /
    `popup_mobile_triggers` を読み書きするデータ層の関数(`getMobileDisplay` 等)は削除した——
    画面・配信は `tests/d1-site-display.test.ts` のサイト単位の表を見る。0004 の AFTER INSERT
    トリガ自体は消していない(凍結。凍結した表・列の扱い)ので、**ここは生 SQL で
    「ポップを作ると frozen な表にも相変わらず1行・6行揃う」ことだけを確かめる**(読まれないが
    書かれ続けることの検査)。
  */
  it("🔴 ポップを作ると、凍結した popup_mobile_display/popup_mobile_triggers にも引き続き行が揃う(読まれないが書かれ続ける)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const display = await db.prepare(`select triggers_mode, frequency_mode from popup_mobile_display where popup_id = ?1`).bind(popupId).first();
    expect(display).toEqual({ triggers_mode: "same_as_pc", frequency_mode: "same_as_pc" });
    const triggerCount = (
      await db.prepare(`select count(*) as c from popup_mobile_triggers where popup_id = ?1`).bind(popupId).first<{ c: number }>()
    )!.c;
    expect(triggerCount).toBe(6);
  });

  it("🔴 パターンを作ると、デザインの行がちょうど1行(same_as_pc・kind は null・content は空)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("v"))).id;
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({
      variantId,
      mode: "same_as_pc",
      kind: null,
      content: {},
    });
  });
});

describe("既存データの移行(0004 適用前に作られた行も揃う)", () => {
  it("✅ 移行後、ポップ数 = popup_mobile_display の行数・ポップ数×6 = popup_mobile_triggers の行数・パターン数 = variant_mobile_designs の行数", async () => {
    // ⚠ openTestD1 は毎回 0001〜最新までを通しで当てるので、ここは「0004 適用後の状態」を
    //   state で確かめる(既存データの移行そのものは tests/d1-migration-additive.test.ts が
    //   「追加だけ」であることを、ここは「数が一致すること」を見る——役割を分けている)。
    const popupCount = (await db.prepare(`select count(*) as c from popups`).first<{ c: number }>())!.c;
    const variantCount = (await db.prepare(`select count(*) as c from variants`).first<{ c: number }>())!.c;
    const displayCount = (await db.prepare(`select count(*) as c from popup_mobile_display`).first<{ c: number }>())!.c;
    const triggerCount = (await db.prepare(`select count(*) as c from popup_mobile_triggers`).first<{ c: number }>())!.c;
    const designCount = (await db.prepare(`select count(*) as c from variant_mobile_designs`).first<{ c: number }>())!.c;
    expect(popupCount, "何も作っていない = 何も測っていない").toBeGreaterThan(0);
    expect(variantCount).toBeGreaterThan(0);
    expect(displayCount).toBe(popupCount);
    expect(triggerCount).toBe(popupCount * 6);
    expect(designCount).toBe(variantCount);
  });
});

describe("デザイン(パターンのスマホ用の上書き)— 画像は PC と同じキーを共有しない", () => {
  it("🔴 テキスト型を custom にすると、PC の見出し・本文等を写す(画像キーは元から無い)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("PCの見出し"))).id;
    const entered = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    expect(entered).toEqual({
      variantId,
      mode: "custom",
      kind: "text",
      content: { headline: "PCの見出し", body: "", buttonLabel: "", imageAlt: "" },
      cleanupPending: 0,
    });
  });

  it("🔴 画像型を custom にすると、PC の画像を**別の R2 キーに複写**する(同じキーを共有しない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const stored = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const pcKey = stored.key;

    const entered = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    expect(entered.mode).toBe("custom");
    expect(entered.kind).toBe("image");
    const mobileKey = entered.content.imageKey as string;
    expect(mobileKey).not.toBe(pcKey); // 🔴 同じキーを共有しない(複写)

    const r2 = await r2Snapshot(t.images);
    const pcEntry = r2.find((e) => e.key === pcKey)!;
    const mobileEntry = r2.find((e) => e.key === mobileKey)!;
    expect(mobileEntry.bodyHex).toBe(pcEntry.bodyHex); // 複写なので中身は同じ

    // PC の画像を差し替えても、スマホの複写(別キー)は影響を受けない
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG_2, contentType: "image/png", ext: "png" }));
    const r2After = await r2Snapshot(t.images);
    expect(r2After.some((e) => e.key === mobileKey)).toBe(true);
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId)).content.imageKey).toBe(mobileKey);
  });

  it("🔴🔴 複写と書き込みの間に PC の画像が差し替わったら、競合として断る(今の PC のテキストと古い画像が混ざった状態を作らない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const pcKeyA = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).key;
    const keysBefore = new Set((await r2Snapshot(t.images)).map((e) => e.key)); // 他のテストが残した分も含めた基準点
    const pendingBefore = new Set(
      (await db.prepare(`select key from pending_image_deletions where owner_id = ?1`).bind(OWNER_A).all<{ key: string }>()).results.map((r) => r.key),
    );

    // B の実体を先に R2 へ置いておく(PC の行だけを後で生 SQL で B に向け替える。差し替え用の
    //   公開 API 〔`storeVariantImage`〕を使うと、A が「もう誰も参照していない」と判定されてその場で
    //   R2 から消えてしまい、再現したい「複写の途中で PC が B に移ったが A はまだ読める」状態を壊すため)
    const pcKeyB = `images/${"b".repeat(32)}.png`;
    await t.images.put(pcKeyB, TINY_PNG_2, { httpMetadata: { contentType: "image/png" } });

    // 🔴 R2 の `get`(= PC の画像 A を読んで複写を始める、まさにその瞬間)を横取りして、
    //   「複写の最中に PC の画像が A → B に差し替わる」を再現する(実物の D1・R2 の上で)。
    const racyImages: typeof t.images = new Proxy(t.images, {
      get(obj, prop) {
        if (prop === "get") {
          return async (key: string) => {
            // enterCustomMobileDesign が PC の画像(A)を読もうとした、まさにその間に PC の行を B へ向け替える
            await db.prepare(`update variants set content = json_set(content, '$.imageKey', ?2) where id = ?1 and owner_id = ?3`).bind(variantId, pcKeyB, OWNER_A).run();
            return (Reflect.get(obj, prop) as (k: string) => unknown).apply(obj, [key]);
          };
        }
        const value_ = Reflect.get(obj, prop);
        return typeof value_ === "function" ? value_.bind(obj) : value_;
      },
    });

    const result = await images.enterCustomMobileDesign({ DB: db, IMAGES: racyImages }, OWNER_A, variantId);
    expect(result).toEqual({ ok: false, failure: { kind: "stale_pc_image" } });

    // 競合で断られたので、スマホのデザインは same_as_pc のまま(書き換わっていない)
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });

    // PC は(生 SQL で向け替えたとおり)B を指したまま——複写した新しいキー(A の複写)だけが、
    //   台帳に積まれたままにせず R2 からも消えていること
    expect(value(await admin.getVariant(db, OWNER_A, variantId)).content.imageKey).toBe(pcKeyB);
    const keysAfter = new Set((await r2Snapshot(t.images)).map((e) => e.key));
    expect(keysAfter.has(pcKeyA)).toBe(true); // 元の PC の画像 A はそのまま残る(消していない)
    expect(keysAfter.has(pcKeyB)).toBe(true); // 差し替え後の PC の画像 B もそのまま残る
    // 基準点から新しく増えたのは B だけ(= 複写した新しいキーは R2 に残っていない)
    const added = [...keysAfter].filter((k) => !keysBefore.has(k));
    expect(added).toEqual([pcKeyB]);
    // 台帳(pending_image_deletions)にも、この操作で新しく増えた行が残っていない
    const pendingAfter = (await db.prepare(`select key from pending_image_deletions where owner_id = ?1`).bind(OWNER_A).all<{ key: string }>()).results.map(
      (r) => r.key,
    );
    expect(pendingAfter.filter((k) => !pendingBefore.has(k))).toEqual([]);
  });

  it("🔴 既に custom なら、もう一度 enterCustomMobileDesign しても何もしない(編集済みの値を失わせない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("PC"))).id;
    value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    value(
      await admin.updateMobileVariantDesign(db, OWNER_A, variantId, {
        kind: "text",
        content: { headline: "スマホ専用", body: "", buttonLabel: "", imageAlt: "" },
      }),
    );
    const again = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    expect(again.content.headline).toBe("スマホ専用"); // PC の "PC" で上書きされていない
  });

  it("🔴🔴 データ層は PC(variants)の行を SQL で直接見る——呼び出し側が渡した画像キーが無くても、PC が画像型である以上 custom にはできない", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id; // PC は画像型・画像は未アップロード
    // 🔴 以前は「見た目(kind・content)を呼び出し側が組み立てたスナップショットで渡す」形で、
    //   例えば `kind: "text"` という嘘を渡せば PC が画像型でも通ってしまっていた。
    //   いまは `newImageKey` しか渡せない——見た目そのものは、このデータ層が PC の行から直接読む。
    const rejected = await admin.setMobileVariantDesignCustom(db, OWNER_A, variantId, null);
    expect(rejected).toEqual({ ok: false, failure: { kind: "invalid", field: "imageKey" } });
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId)).mode).toBe("same_as_pc");
  });

  it("🔴 データ層は PC の kind をそのまま使う: PC がテキスト型なら、呼び出し側が画像キーを渡しても custom は画像型にならない(content にも imageKey は入らない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("PCの見出し"))).id; // PC はテキスト型
    const entered = value(
      await admin.setMobileVariantDesignCustom(db, OWNER_A, variantId, {
        newKey: `images/${"9".repeat(32)}.png`,
        copiedFromKey: `images/${"9".repeat(32)}.png`,
      }),
    );
    expect(entered).toEqual({
      variantId,
      mode: "custom",
      kind: "text", // 渡した画像キーに関わらず、PC の実際の kind(text)がそのまま使われる
      content: { headline: "PCの見出し", body: "", buttonLabel: "", imageAlt: "" }, // imageKey は入らない
    });
  });

  it("🔴🔴 PC が画像型なのに画像キーが無いと、custom への切り替えを拒否する(配れるかどうかは PC 側だけで決まる不変条件を守る)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id; // 画像はまだアップロードしていない
    expect(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).toEqual({ ok: false, failure: { kind: "invalid", field: "imageKey" } });
    // 拒否された = 何も書き換えられていない(same_as_pc のまま)
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });
  });

  it("🔴🔴 PC の画像キーはあるが R2 に実体が無い(宙に浮いた参照)なら、custom への切り替えを拒否する", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const pcKey = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).key;
    await t.images.delete(pcKey); // R2 からだけ消す(DB の参照はそのまま=宙に浮いた参照を再現)
    expect(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).toEqual({ ok: false, failure: { kind: "invalid", field: "imageKey" } });
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });
  });

  it("🔴🔴 データ層(setMobileVariantDesignCustom)は、渡された複写元のキーが PC の今のキーと一致しない限り書かない(images.ts を経由しない呼び出しへの守り)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })); // PC は実際には別のキーを持つ
    // ⚠ images.ts を経由せず直接呼ぶ。複写元として渡した(もっともらしい)キーが PC の今のキーと一致しない
    expect(
      await admin.setMobileVariantDesignCustom(db, OWNER_A, variantId, {
        newKey: `images/${"a".repeat(32)}.png`,
        copiedFromKey: `images/${"c".repeat(32)}.png`,
      }),
    ).toEqual({ ok: false, failure: { kind: "stale_pc_image" } });
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId)).mode).toBe("same_as_pc"); // 書き換わっていない
  });

  it("🔴🔴 画像型のまま、スマホの個別の画像キーだけを外すことはできない(画像の差し替えはアップロードで行う)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    const beforeKey = value(await admin.getMobileVariantDesign(db, OWNER_A, variantId)).content.imageKey as string;

    expect(await images.removeMobileVariantImage(env(), OWNER_A, variantId)).toEqual({ ok: false, failure: { kind: "invalid", field: "kind" } });

    const after = value(await admin.getMobileVariantDesign(db, OWNER_A, variantId));
    expect(after.kind).toBe("image");
    expect(after.content.imageKey).toBe(beforeKey); // 外れていない
    expect((await r2Snapshot(t.images)).some((e) => e.key === beforeKey)).toBe(true); // R2 からも消えていない
  });

  it("🔴 same_as_pc に戻すと、スマホの個別の画像は**その要求の中で**すぐ R2 から消える(消し直し待ちに積まれっぱなしにしない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);

    const restored = value(await images.restoreMobileVariantDesignWithImages(env(), OWNER_A, variantId));
    expect(restored.cleanupPending).toBe(0);
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });
    // ⚠ retryPendingImageDeletions を呼ばずに、この時点でもう消えていること(= 同じ要求の中で drain した証拠)
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(false);
    expect(await db.prepare(`select 1 from pending_image_deletions where key = ?1`).bind(mobileKey).first()).toBeNull();
  });

  it("🔴🔴 R2 の削除が失敗しても 200 で隠さない: 応答の cleanupPending に出て、台帳(pending_image_deletions)にも残る", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;

    // R2 の delete だけを落とす Proxy(実物の D1・R2 の上で、1つのメソッドだけを失敗させる)
    const failingImages: typeof t.images = new Proxy(t.images, {
      get(obj, prop) {
        if (prop === "delete") return () => Promise.reject(new Error("delete failed"));
        const value = Reflect.get(obj, prop);
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });

    const restored = value(await images.restoreMobileVariantDesignWithImages({ DB: db, IMAGES: failingImages }, OWNER_A, variantId));
    expect(restored.cleanupPending).toBe(1); // 隠れていない
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });
    // R2 からは消えておらず(delete が失敗した)、台帳にはまだ残っている
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);
    expect(await db.prepare(`select 1 from pending_image_deletions where key = ?1`).bind(mobileKey).first()).not.toBeNull();

    // 🔴 後片付け: このファイルは全テストで同じ D1・R2 を使い回す(beforeAll で1回だけ開く)ので、
    //   わざと残した積んだままの行・R2 の中身を、ここで消しておく(後続のテストの「所有者分の台帳・R2 を
    //   数え上げる」アサーションを汚さないため)。失敗しない本物の bucket を使って消し直す
    value(await images.retryPendingImageDeletions(env(), OWNER_A, new Date(Date.now() + images.RETRY_MIN_AGE_MS)));
  });

  it("🔴🔴 enterCustomMobileDesign も、片付けられずに残っている画像を隠さない(cleanupPending に出る)", async () => {
    // 事前に、片付けられないまま残っている画像を1つ用意する(R2 の delete を失敗させて作る。
    //   この所有者のための「片付け待ちが既にある」状態を再現する——今回の呼び出し自体が複写に
    //   失敗したかどうかとは別の軸であることを確かめるため、ここでは複写が要らないテキスト型で呼ぶ)
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const strandedVariantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, strandedVariantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const strandedKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, strandedVariantId)).content.imageKey as string;
    const failingImages: typeof t.images = new Proxy(t.images, {
      get(obj, prop) {
        if (prop === "delete") return () => Promise.reject(new Error("delete failed"));
        const value_ = Reflect.get(obj, prop);
        return typeof value_ === "function" ? value_.bind(obj) : value_;
      },
    });
    value(await images.restoreMobileVariantDesignWithImages({ DB: db, IMAGES: failingImages }, OWNER_A, strandedVariantId));
    expect(await db.prepare(`select 1 from pending_image_deletions where key = ?1`).bind(strandedKey).first()).not.toBeNull(); // 片付け待ちが残っている

    // ここからが本題: 複写が要らない別のパターンで enterCustomMobileDesign を呼んでも、
    //   「この所有者はまだ片付け待ちを抱えている」ことが応答から見える(隠れていない)
    const textVariantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("v"))).id;
    const entered = value(await images.enterCustomMobileDesign(env(), OWNER_A, textVariantId));
    expect(entered.cleanupPending).toBeGreaterThan(0);

    // 後片付け
    value(await images.retryPendingImageDeletions(env(), OWNER_A, new Date(Date.now() + images.RETRY_MIN_AGE_MS)));
  });

  it("🔴 same_as_pc に戻すと、スマホの個別の画像は消し直し待ちへ積まれ、後で R2 から消える", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const entered = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId));
    const mobileKey = entered.content.imageKey as string;
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);

    value(await admin.restoreMobileVariantDesign(db, OWNER_A, variantId));
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual({ variantId, mode: "same_as_pc", kind: null, content: {} });

    // 積んでから間もないので、この時点ではまだ消えていない設計(RETRY_MIN_AGE_MS)。古い行として消し直す
    await db.prepare(`update pending_image_deletions set created_at = '2000-01-01T00:00:00.000Z' where key = ?1`).bind(mobileKey).run();
    value(await images.retryPendingImageDeletions(env(), OWNER_A));
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(false);
  });

  it("🔴 画像型は、スマホの個別の画像キーが無いと保存できない(配れる状態でしか保存できない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("v"))).id;
    value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)); // text のまま custom に
    expect(
      await admin.updateMobileVariantDesign(db, OWNER_A, variantId, {
        kind: "image",
        content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" },
      }),
    ).toEqual({ ok: false, failure: { kind: "invalid", field: "imageKey" } });

    value(await images.setMobileVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    expect(
      await admin.updateMobileVariantDesign(db, OWNER_A, variantId, {
        kind: "image",
        content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" },
      }),
    ).toEqual({ ok: true, value: null });
  });

  it("🔴 same_as_pc のときの updateMobileVariantDesign / setMobileVariantImage は not_custom", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("v"))).id;
    expect(
      await admin.updateMobileVariantDesign(db, OWNER_A, variantId, { kind: "text", content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" } }),
    ).toEqual({ ok: false, failure: { kind: "not_custom" } });
    expect(await images.setMobileVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).toEqual({
      ok: false,
      failure: { kind: "not_custom" },
    });
  });

  it("🔴🔴 拒否された(not_custom の)呼び出しは、消し直し待ちの台帳(pending_image_deletions)を変えない——積む文(INSERT)と書く文(UPDATE)の条件をそろえる", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("v"))).id;
    value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)); // kind: "text" のまま custom に

    // ⚠ ここだけ、生SQLで「kind は text(= 外す操作そのものは許される形)だが、
    //   content.imageKey はまだ残っていて、しかも mode は same_as_pc」という、通常の API からは
    //   作れない不整合をわざと作る(将来どこかが同じ不整合を作ってしまっても、このデータ層が
    //   積む文だけ暴走しないことを確かめるため=防御的な守り。kind<>'image' のガードだけでは
    //   このケースを防げない——mode 自体のガードが積む文に要る、という理由で必要な守り)。
    const vestigialKey = `images/${"7".repeat(32)}.png`;
    await db
      .prepare(`update variant_mobile_designs set content = json_set(content, '$.imageKey', ?2), mode = 'same_as_pc' where variant_id = ?1`)
      .bind(variantId, vestigialKey)
      .run();

    const before = await db.prepare(`select 1 from pending_image_deletions where key = ?1`).bind(vestigialKey).first();
    expect(before, "積み忘れた体で始めたい").toBeNull();

    expect(await admin.setMobileVariantImageKey(db, OWNER_A, variantId, null)).toEqual({ ok: false, failure: { kind: "not_custom" } });

    // 🔴 断られた呼び出しが、台帳(pending_image_deletions)を変えていないこと
    expect(await db.prepare(`select 1 from pending_image_deletions where key = ?1`).bind(vestigialKey).first()).toBeNull();
  });
});

describe("削除(cascade)でスマホの画像も R2 から残らない", () => {
  it("🔴🔴 削除(DB だけ・`admin.ts`)は、PC とスマホ両方の画像キーを `pending_image_deletions` へ積む(write-ahead そのものを見る。`images.ts` の `drain` を経由しない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const keep = value(await admin.createVariant(db, OWNER_A, popupId, textInput("残す"))).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const pcKey = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).key;
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;

    const deleted = value(await admin.deleteVariant(db, OWNER_A, variantId)); // images.ts を経由しない(drain を呼ばない)
    expect(new Set(deleted.queuedImageKeys)).toEqual(new Set([pcKey, mobileKey]));
    const pending = (await db.prepare(`select key from pending_image_deletions where owner_id = ?1`).bind(OWNER_A).all<{ key: string }>()).results.map(
      (r) => r.key,
    );
    expect(new Set(pending)).toEqual(new Set([pcKey, mobileKey]));
    void keep;
  });

  it("🔴 パターンを削除すると、PC とスマホ両方の画像が消し直し待ちに積まれ、消える", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const keep = value(await admin.createVariant(db, OWNER_A, popupId, textInput("残す"))).id; // 配信可能な行を1つ残す
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const pcKey = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).key;
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;
    expect((await r2Snapshot(t.images)).map((e) => e.key)).toEqual(expect.arrayContaining([pcKey, mobileKey]));

    const deleted = value(await images.deleteVariantWithImages(env(), OWNER_A, variantId));
    expect(deleted.cleanupPending).toBeGreaterThanOrEqual(0);
    await db.prepare(`update pending_image_deletions set created_at = '2000-01-01T00:00:00.000Z' where owner_id = ?1`).bind(OWNER_A).run();
    value(await images.retryPendingImageDeletions(env(), OWNER_A));
    const keys = (await r2Snapshot(t.images)).map((e) => e.key);
    expect(keys).not.toContain(pcKey);
    expect(keys).not.toContain(mobileKey);
    void keep;
  });

  it("🔴 ポップを削除すると、配下の全パターンの PC・スマホ両方の画像が消える", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const pcKey = value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" })).key;
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;

    value(await images.deletePopupWithImages(env(), OWNER_A, popupId));
    await db.prepare(`update pending_image_deletions set created_at = '2000-01-01T00:00:00.000Z' where owner_id = ?1`).bind(OWNER_A).run();
    value(await images.retryPendingImageDeletions(env(), OWNER_A));
    const keys = (await r2Snapshot(t.images)).map((e) => e.key);
    expect(keys).not.toContain(pcKey);
    expect(keys).not.toContain(mobileKey);

    // 配下の行も cascade で消えている
    expect(await db.prepare(`select 1 from popup_mobile_display where popup_id = ?1`).bind(popupId).first()).toBeNull();
    expect(await db.prepare(`select 1 from popup_mobile_triggers where popup_id = ?1`).bind(popupId).first()).toBeNull();
    expect(await db.prepare(`select 1 from variant_mobile_designs where variant_id = ?1`).bind(variantId).first()).toBeNull();
  });
});

describe("アーカイブ(復元できる操作)では、スマホの設定も画像も消さない", () => {
  // 🔴 アーカイブは「物理削除」ではなく「配信から外すが戻せる」操作(PC 側も archived_at を立てるだけで
  //   行も画像も消さない)。スマホ側だけ別扱いにする理由は無いので、同じ約束にする——
  //   「アーカイブ→復元でスマホの設定・画像が戻ること」を状態で固定する(消えないことの裏返し)。

  it("🔴 パターンをアーカイブ→復元しても、スマホの個別デザインと画像は変わらない(R2 からも消えない)", async () => {
    const siteId = await newSite();
    const popupId = await newPopup(siteId);
    value(await admin.createVariant(db, OWNER_A, popupId, textInput("残す"))); // 配信可能な行を1つ残す
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await images.storeVariantImage(env(), OWNER_A, variantId, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
    const mobileKey = value(await images.enterCustomMobileDesign(env(), OWNER_A, variantId)).content.imageKey as string;
    const beforeArchive = value(await admin.getMobileVariantDesign(db, OWNER_A, variantId));
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);

    value(await admin.archiveVariant(db, OWNER_A, variantId));
    // アーカイブ中も、スマホのデザインの行・R2 の画像はそのまま残っている(消えない)
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual(beforeArchive);
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);

    value(await admin.restoreVariant(db, OWNER_A, variantId));
    // 復元後も同じ値・同じ画像のまま戻る
    expect(value(await admin.getMobileVariantDesign(db, OWNER_A, variantId))).toEqual(beforeArchive);
    expect((await r2Snapshot(t.images)).some((e) => e.key === mobileKey)).toBe(true);
  });
});
