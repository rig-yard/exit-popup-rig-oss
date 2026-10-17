// @vitest-environment node
//
// 旧名(ADPOP 時代の公開名)の**互換**と、新旧が両方付いたときの**優先順位**を固定する。
//
// 守りたいこと: すでに LP に貼られたタグ・キャッシュ中の旧ローダが、改名後も壊れない。
//   ・タグの属性  `data-adpop-site`   → 新: `data-exit-popup-site`(両方なら、新名が空でなければ新名が勝つ。空なら旧名)
//   ・プレビュー  `?adpop_preview=1`  → 新: `?exit_popup_preview=1`(両方なら新名の値だけを見る)
//   ・本体のパス  `/embed/adpop.js`   → 新: `/embed/exit-popup.js`(旧パスも同じ中身を配る)
//   ・グローバル  `__adpopExitPopup`  → 新: `__exitPopupBridge`(本体は旧名の鍵も読む。書くのは新名だけ)
//   ・関数        `startAdpop`        → 新: `startExitPopup`(同じ関数の別名)
//
// ⚠ 測った範囲: 上の5つの読み取り/配信の経路。**実ブラウザ・実際の LP・CDN のキャッシュ越しでは測っていない**。
//   (旧ローダ + 新本体の組み合わせは、旧名の鍵に注文を置いた状態を作って本体を動かして測る)
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_NAMESPACE,
  LEGACY_RUNTIME_PATH,
  LEGACY_SITE_ATTRIBUTE,
  NAMESPACE,
  readBridge,
  RUNTIME_PATH,
  SITE_ATTRIBUTE,
  writeBridge,
  type Bridge,
} from "../packages/embed/src/bridge";
import { readTag, startAdpop, startExitPopup } from "../packages/embed/src/loader";
import { buildPopupView } from "../packages/embed/src/popup-view";
import { startRuntime } from "../packages/embed/src/runtime";
import { embedTag } from "../src/app/_lib/embedTag";
import { BUNDLES, DELIVERY_ASSETS_DIR } from "../scripts/bundle-size.mjs";

const NEW_KEY = "a".repeat(32);
const OLD_KEY = "b".repeat(32);
const DELIVERY = "https://delivery.example.com";
const PAGE = "https://lp.example.com/lp";

type Win = Window & typeof globalThis;

let dom: JSDOM;
let win: Win;
let doc: Document;
let configRequests: string[];

function newDom(url = PAGE): void {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url, pretendToBeVisual: true });
  win = dom.window as unknown as Win;
  doc = win.document;
  (win as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
    cb();
    return 0;
  };
}

function addTag(attributes: Record<string, string>): HTMLScriptElement {
  const script = doc.createElement("script");
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  script.src = `${DELIVERY}/embed/t.js`;
  doc.head.appendChild(script);
  return script;
}

function stubConfig(): void {
  (win as unknown as { fetch: unknown }).fetch = vi.fn((input: RequestInfo | URL) => {
    configRequests.push(String(input));
    // 形が読めない応答 = fail-closed で何もしない。ここでは「どのサイトキーで取りに行ったか」だけ見る
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  configRequests = [];
  newDom();
});
afterEach(() => {
  dom.window.close();
  vi.restoreAllMocks();
});

describe("タグの属性(読み取り)", () => {
  it("新名だけのタグを読める", () => {
    addTag({ [SITE_ATTRIBUTE]: NEW_KEY });
    expect(readTag(doc)).toEqual({ siteKey: NEW_KEY, deliveryOrigin: DELIVERY });
  });

  it("🔴 旧名だけのタグ(すでに貼られたもの)を読める", () => {
    addTag({ "data-adpop-site": OLD_KEY });
    expect(readTag(doc)).toEqual({ siteKey: OLD_KEY, deliveryOrigin: DELIVERY });
  });

  it("🔴 新旧の両方が付いたら、新名が空でなければ新名が勝つ(値が違っても)", () => {
    addTag({ "data-adpop-site": OLD_KEY, "data-exit-popup-site": NEW_KEY });
    expect(readTag(doc)?.siteKey).toBe(NEW_KEY);
  });

  it("新名が空文字なら旧名に落ちる(空のキーで取りに行かない)", () => {
    addTag({ "data-exit-popup-site": "", "data-adpop-site": OLD_KEY });
    expect(readTag(doc)?.siteKey).toBe(OLD_KEY);
  });

  it("どちらも空なら読まない(fail-closed)", () => {
    addTag({ "data-exit-popup-site": "", "data-adpop-site": "" });
    expect(readTag(doc)).toBeNull();
  });

  it("属性名の定数が、文書に書いた名前と一致している(定数だけ書き換わっても気づく)", () => {
    expect(SITE_ATTRIBUTE).toBe("data-exit-popup-site");
    expect(LEGACY_SITE_ATTRIBUTE).toBe("data-adpop-site");
  });

  it("🔴 旧名のタグで起動し、そのサイトキーで設定を取りに行く(起動の経路を通す)", async () => {
    stubConfig();
    addTag({ "data-adpop-site": OLD_KEY });
    expect(startExitPopup(win, doc)).toBe(true);
    await flush();
    expect(configRequests).toEqual([`${DELIVERY}/api/v1/config?site_key=${OLD_KEY}`]);
  });

  it("🔴 新旧の両方が付いたタグで起動すると、新名のサイトキーで取りに行く", async () => {
    stubConfig();
    addTag({ "data-adpop-site": OLD_KEY, "data-exit-popup-site": NEW_KEY });
    startExitPopup(win, doc);
    await flush();
    expect(configRequests).toEqual([`${DELIVERY}/api/v1/config?site_key=${NEW_KEY}`]);
  });
});

describe("プレビューのパラメータ(読み取り)", () => {
  // 設定が取れなかったときのイベント送信を見るのではなく、「頻度制御を無視する」を直接測るには
  // 描画まで通す必要がある。ここでは起動後の `ctx.preview` が見えないため、描画の流れを最小で作る。
  async function previewShows(query: string): Promise<boolean> {
    newDom(`${PAGE}${query}`);
    // 頻度制御で抑制される状態(直前に見た)を作る。プレビューなら無視して出る
    win.localStorage.setItem(`adpop:${NEW_KEY}`, JSON.stringify({ lastImpressionAt: Date.now() }));
    const config = {
      v: 1,
      popup: {
        key: "p".repeat(32),
        minDisplayDelaySeconds: 0,
        frequency: { suppressDays: 30, sessionImpressions: 1, postConversionDays: 0 },
        triggers: [{ kind: "exit_intent", threshold: null }],
        variants: [
          {
            key: "v".repeat(32),
            kind: "text",
            weight: 100,
            content: { headline: "見出し", body: "本文", buttonLabel: "確認する" },
            destinationUrl: "https://offer.example.com/a",
          },
        ],
      },
    };
    (win as unknown as { fetch: unknown }).fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/events")) return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(config) });
    });
    addTag({ [SITE_ATTRIBUTE]: NEW_KEY });
    startExitPopup(win, doc);
    await flush();
    doc.documentElement.dispatchEvent(new win.MouseEvent("mouseleave", { clientY: 0, relatedTarget: null }));
    await flush();
    startRuntime(win, doc);
    await flush();
    return doc.querySelector("[data-exit-popup]") !== null;
  }

  it("プレビュー無しなら、抑制されていて出ない(前提)", async () => {
    expect(await previewShows("")).toBe(false);
  });

  it("新名 ?exit_popup_preview=1 で出る", async () => {
    expect(await previewShows("?exit_popup_preview=1")).toBe(true);
  });

  it("🔴 旧名 ?adpop_preview=1 でも出る", async () => {
    expect(await previewShows("?adpop_preview=1")).toBe(true);
  });

  it("🔴 新名が 0・旧名が 1 なら出ない(新名の値が勝つ)", async () => {
    expect(await previewShows("?exit_popup_preview=0&adpop_preview=1")).toBe(false);
  });

  it("🔴 新名が 1・旧名が 0 なら出る(新名の値が勝つ)", async () => {
    expect(await previewShows("?exit_popup_preview=1&adpop_preview=0")).toBe(true);
  });
});

describe("グローバル(ローダと本体の受け渡し口)", () => {
  it("書くのは新名の鍵だけで、旧名の鍵は生やさない", () => {
    const target: Record<string, unknown> = {};
    writeBridge(target, { version: "x" });
    expect(Object.keys(target)).toEqual([NAMESPACE]);
    expect(NAMESPACE).toBe("__exitPopupBridge");
  });

  it("🔴 旧名の鍵に置かれたものも読める(旧ローダ + 新本体)", () => {
    const legacy: Bridge = { version: "legacy" };
    expect(readBridge({ [LEGACY_NAMESPACE]: legacy })).toBe(legacy);
    expect(LEGACY_NAMESPACE).toBe("__adpopExitPopup");
  });

  it("🔴 新旧の鍵が両方あれば新名が勝つ", () => {
    const next: Bridge = { version: "new" };
    expect(readBridge({ [NAMESPACE]: next, [LEGACY_NAMESPACE]: { version: "legacy" } })).toBe(next);
  });

  it("🔴 旧ローダが旧名の鍵に置いた注文を、新しい本体が描く", async () => {
    const sent: unknown[] = [];
    const bridge: Bridge = {
      version: "legacy-loader",
      request: {
        popupKey: "p".repeat(32),
        variant: {
          key: "v".repeat(32),
          kind: "text",
          weight: 100,
          content: { headline: "旧ローダの注文", body: "本文", buttonLabel: "確認する" },
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: PAGE,
        impressionId: "i".repeat(32),
      },
      send: (event) => sent.push(event),
    };
    (win as unknown as Record<string, unknown>)[LEGACY_NAMESPACE] = bridge;
    startRuntime(win, doc);
    await flush();
    expect(doc.querySelector("[data-exit-popup]")?.shadowRoot?.textContent).toContain("旧ローダの注文");
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("関数名・DOM の目印", () => {
  it("startAdpop は startExitPopup の別名(同じ関数)", () => {
    expect(startAdpop).toBe(startExitPopup);
  });

  it("ポップの外側の要素に、新旧の目印が両方付く(LP 側の CSS が旧名を指していても効く)", () => {
    const view = buildPopupView(doc, {
      kind: "text",
      content: { headline: "h", body: "b", buttonLabel: "c" },
    } as Parameters<typeof buildPopupView>[1]);
    expect(view.host.hasAttribute("data-exit-popup")).toBe(true);
    expect(view.host.hasAttribute("data-adpop")).toBe(true);
  });
});

describe("管理画面が出すタグ", () => {
  it("🔴 新名の属性だけを出す(旧名は出さない)", () => {
    const tag = embedTag(DELIVERY, NEW_KEY);
    expect(tag).toBe(`<script async src="${DELIVERY}/embed/t.js" data-exit-popup-site="${NEW_KEY}"></script>`);
    expect(tag).not.toContain("adpop");
  });

  it("配信元が未設定なら出さない", () => {
    expect(embedTag("", NEW_KEY)).toBeNull();
  });
});

describe("配信パス(ビルドの出力先)", () => {
  const runtime = BUNDLES.find((bundle) => bundle.id === "runtime");

  it("新パス /embed/exit-popup.js が本体のパス", () => {
    expect(RUNTIME_PATH).toBe("/embed/exit-popup.js");
    expect(runtime?.url).toBe(RUNTIME_PATH);
  });

  it("🔴 旧パス /embed/adpop.js にも同じ本体を書き出す設定になっている", () => {
    expect(LEGACY_RUNTIME_PATH).toBe("/embed/adpop.js");
    expect(runtime?.legacyPublicOuts).toEqual([`${DELIVERY_ASSETS_DIR}${LEGACY_RUNTIME_PATH}`]);
  });

  it("ローダのソースが LEGACY_RUNTIME_PATH を参照していない(字面の検査。取りに行く先が新パスであることは embed-flow の exit-popup.js の検査が見る)", () => {
    const source = readFileSync(path.join(__dirname, "../packages/embed/src/loader.ts"), "utf8");
    expect(source).not.toContain("LEGACY_RUNTIME_PATH");
  });
});
