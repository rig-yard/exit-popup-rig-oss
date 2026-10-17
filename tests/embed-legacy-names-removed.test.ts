// @vitest-environment node
//
// 旧名(ADPOP 時代の公開名)が**動かない**ことを固定する。互換は意図して外した
// (外部に旧名のタグは貼られておらず、npm にも未公開のため)。
//
// 固定するのは次の5つの旧名(検査は計6件。`it` を数えれば検算できる):
//   ・旧属性 `data-adpop-site` だけのタグ      → 読まない・起動しても設定を取りに行かない(2件)
//   ・旧プレビュー `?adpop_preview=1`          → 頻度制御を無視して出す効果が無い
//   ・旧グローバル `__adpopExitPopup`           → 本体が読まない(注文が置かれても描かない)
//   ・旧関数 `startAdpop`                       → export されていない
//   ・ホスト要素の旧属性 `data-adpop`           → 付かない
// 旧パス `/embed/adpop.js` が 404 になることは `tests/d1-worker-runtime.test.ts` が見る。
//
// ⚠ 測った範囲: jsdom 上の読み取り経路。**実ブラウザ・実際の LP・CDN のキャッシュ越しでは測っていない**。
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE, readBridge, type Bridge } from "../packages/embed/src/bridge";
import * as loaderModule from "../packages/embed/src/loader";
import { readTag, startExitPopup } from "../packages/embed/src/loader";
import { buildPopupView } from "../packages/embed/src/popup-view";
import { startRuntime } from "../packages/embed/src/runtime";

const KEY = "a".repeat(32);
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TEXT_VARIANT = {
  key: "v".repeat(32),
  kind: "text" as const,
  weight: 100,
  content: { headline: "見出し", body: "本文", buttonLabel: "確認する" },
  destinationUrl: "https://offer.example.com/a",
};

beforeEach(() => {
  configRequests = [];
  newDom();
});
afterEach(() => {
  dom.window.close();
  vi.restoreAllMocks();
});

describe("旧名は動かない", () => {
  it("旧属性 data-adpop-site だけのタグは読まない", () => {
    addTag({ "data-adpop-site": KEY });
    expect(readTag(doc)).toBeNull();
  });

  it("旧属性だけのタグでは起動せず、設定も取りに行かない", async () => {
    (win as unknown as { fetch: unknown }).fetch = vi.fn((input: RequestInfo | URL) => {
      configRequests.push(String(input));
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    });
    addTag({ "data-adpop-site": KEY });
    expect(startExitPopup(win, doc)).toBe(false);
    await flush();
    expect(configRequests).toEqual([]);
  });

  it("旧プレビュー ?adpop_preview=1 では、頻度制御で抑制された状態のまま出ない", async () => {
    newDom(`${PAGE}?adpop_preview=1`);
    // 直前に見た = 頻度制御で抑制される状態。新名のプレビューなら無視して出る(旧名には、その効果が無い)
    win.localStorage.setItem(`adpop:${KEY}`, JSON.stringify({ lastImpressionAt: Date.now() }));
    const config = {
      v: 1,
      popup: {
        key: "p".repeat(32),
        minDisplayDelaySeconds: 0,
        frequency: { suppressDays: 30, sessionImpressions: 1, postConversionDays: 0 },
        triggers: [{ kind: "exit_intent", threshold: null }],
        variants: [TEXT_VARIANT],
      },
    };
    (win as unknown as { fetch: unknown }).fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/events")) return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(config) });
    });
    addTag({ "data-exit-popup-site": KEY });
    startExitPopup(win, doc);
    await flush();
    doc.documentElement.dispatchEvent(new win.MouseEvent("mouseleave", { clientY: 0, relatedTarget: null }));
    await flush();
    startRuntime(win, doc);
    await flush();
    expect(doc.querySelector("[data-exit-popup]")).toBeNull();
  });

  it("旧グローバル __adpopExitPopup に置かれた注文は読まず、描かない", async () => {
    const bridge: Bridge = {
      version: "old-loader",
      request: {
        popupKey: "p".repeat(32),
        variant: TEXT_VARIANT,
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: PAGE,
        impressionId: "i".repeat(32),
      },
      send: () => {},
    };
    (win as unknown as Record<string, unknown>)["__adpopExitPopup"] = bridge;
    expect(readBridge(win)).toBeUndefined();
    startRuntime(win, doc);
    await flush();
    expect(doc.querySelector("[data-exit-popup]")).toBeNull();
    expect(NAMESPACE).toBe("__exitPopupBridge");
  });

  it("旧関数 startAdpop は export されていない", () => {
    expect("startAdpop" in loaderModule).toBe(false);
  });

  it("ホスト要素に旧属性 data-adpop は付かない", () => {
    const view = buildPopupView(doc, {
      kind: "text",
      content: { headline: "h", body: "b", buttonLabel: "c" },
    } as Parameters<typeof buildPopupView>[1]);
    expect(view.host.hasAttribute("data-exit-popup")).toBe(true);
    expect(view.host.hasAttribute("data-adpop")).toBe(false);
  });
});
