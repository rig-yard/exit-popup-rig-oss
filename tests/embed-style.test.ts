// @vitest-environment jsdom
//
// 🔴 埋め込みのスタイルが、埋め込み先(LP)の文書ルートの `font-size` に左右されないことを固定する
//   。`rem`/`em` は `<html>` の `font-size` を基準にするので、
//   `:host { all: initial }` では遮れない——**寸法は px の絶対値**にする、という決定そのものを撃つ。
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { NAMESPACE, type Bridge } from "../packages/embed/src/bridge";
import { startRuntime, STYLE } from "../packages/embed/src/runtime";

describe("STYLE の単位(字面の検査。'px の絶対値にする'という決定そのものが対象)", () => {
  it("🔴 `rem`/`em` を1文字も含まない", () => {
    // ⚠ 単語の一部(例: ".image" の "em" ではなく、数値に続く rem/em だけを拾う)
    const matches = STYLE.match(/\d+(\.\d+)?(rem|em)\b/g);
    expect(matches, `rem/em が残っている: ${JSON.stringify(matches)}`).toBeNull();
  });

  it("✅ 閉じるボタン(テキスト型・画像型どちらも)は min-width/min-height が 44px", () => {
    expect(STYLE).toMatch(/\.close\s*\{[^}]*min-width:\s*44px/);
    expect(STYLE).toMatch(/\.close\s*\{[^}]*min-height:\s*44px/);
    expect(STYLE).toMatch(/\.close-image\s*\{[^}]*min-width:\s*44px/);
    expect(STYLE).toMatch(/\.close-image\s*\{[^}]*min-height:\s*44px/);
  });

  it("✅ CTA ボタンの min-height も 44px(タッチターゲットの下限)", () => {
    expect(STYLE).toMatch(/\.cta\s*\{[^}]*min-height:\s*44px/);
  });

  it("🔴 .cta は box-sizing: border-box(無いと padding 分だけ見た目の高さが44pxを超える)", () => {
    expect(STYLE).toMatch(/\.cta\s*\{[^}]*box-sizing:\s*border-box/);
  });

  it("✅ 画像の max-height は 70vh(ビューポート基準。host の font-size に左右されない)", () => {
    expect(STYLE).toMatch(/\.image\s*\{[^}]*max-height:\s*70vh/);
  });
});

describe(".backdrop.preview-flat(管理画面プレビュー専用)", () => {
  it("🔴 固定配置・暗い背景・最前面だけを打ち消す(font-family等には触れない=別ルールのまま)", () => {
    const match = STYLE.match(/\.backdrop\.preview-flat\s*\{([^}]*)\}/);
    expect(match, ".backdrop.preview-flat の規則が見つからない").not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/position:\s*static/);
    expect(body).toMatch(/z-index:\s*auto/);
    expect(body).not.toMatch(/background:\s*rgba/);
    // font-family/line-height/color は .backdrop 本体のルールにしか無い(ここで上書きしていない)
    expect(body).not.toMatch(/font-family|line-height|color/);
  });
});

describe("閉じるボタン(画像型)は .close と同じ字形・大きさ・濃い色(最新の決定どおり)", () => {
  function ruleBody(selector: string): string {
    const match = STYLE.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} の規則が見つからない`).not.toBeNull();
    return match![1];
  }

  it("🔴 .close-image に塗り(background)・丸(border-radius: 50%)が無い", () => {
    const body = ruleBody(".close-image");
    expect(body).not.toMatch(/border-radius:\s*50%/);
    expect(body).not.toMatch(/background:\s*rgba/);
  });

  it("✅ .close と同じ字形の大きさ・濃い色(#1a1a1a・font-size 16px)", () => {
    const closeBody = ruleBody(".close");
    const imageBody = ruleBody(".close-image");
    const fontSize = (body: string) => body.match(/font-size:\s*(\d+px)/)?.[1];
    const color = (body: string) => body.match(/color:\s*(#[0-9a-f]+)/i)?.[1];
    expect(fontSize(imageBody)).toBe(fontSize(closeBody));
    expect(color(imageBody)).toBe(color(closeBody));
  });

  it("✅ 暗い画像の上で消えないよう、白いにじみ(text-shadow)だけを持つ(輪郭線や塗りの面は作らない)", () => {
    const body = ruleBody(".close-image");
    expect(body).toMatch(/text-shadow:/);
    expect(body).toMatch(/rgba\(255,255,255/);
  });
});

describe("「GIF」の印を LP 側に出さない", () => {
  type Win = Window & typeof globalThis;
  function newWin(): { win: Win; doc: Document } {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
    const win = dom.window as unknown as Win;
    (win as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };
    return { win, doc: win.document };
  }

  it("🔴 GIF の画像パターンを描いても、DOM のどこにも「GIF」の文字が出ない", async () => {
    const { win, doc } = newWin();
    const bridge: Bridge = {
      version: "test",
      request: {
        popupKey: "p".repeat(32),
        variant: {
          key: "v".repeat(32),
          kind: "image",
          weight: 100,
          content: { imageAlt: "キャンペーン告知", imageKey: `images/${"a".repeat(32)}.gif` },
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: "https://lp.example.com/",
        impressionId: "aaaaaaaa-0000-0000-0000-000000000099",
        deliveryOrigin: "https://delivery.example.com",
      },
      send: () => {},
    };
    (win as unknown as Record<string, Bridge>)[NAMESPACE] = bridge;

    // GIF も静止画と同じ <img> で描く(読み込みはこの検査の対象外なので即 load させる)
    const proto = win.HTMLImageElement.prototype;
    Object.defineProperty(proto, "src", {
      configurable: true,
      get() {
        return this.getAttribute("src") ?? "";
      },
      set(value: string) {
        this.setAttribute("src", value);
        queueMicrotask(() => this.dispatchEvent(new win.Event("load")));
      },
    });

    startRuntime(win, doc);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const host = doc.querySelector("[data-exit-popup]");
    expect(host, "GIFの画像ポップが描かれていない(この検査の前提が壊れている)").not.toBeNull();
    // ⚠ `<style>` の中身(CSS コメント含む)は訪問者にもスクリーンリーダーにも見えないので対象外。
    //   見るのは `.panel`(実際に描かれた要素)の文字とラベルだけ。
    const panel = host?.shadowRoot?.querySelector(".panel");
    const text =
      (panel?.textContent ?? "") +
      JSON.stringify([...(panel?.querySelectorAll("*") ?? [])].map((el) => el.getAttribute("aria-label")));
    expect(/gif/i.test(text), `「GIF」の文字が出ている: ${text}`).toBe(false);
    win.close();
  });
});
