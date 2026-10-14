// @vitest-environment jsdom
//
// `packages/embed/src/popup-view.ts` の**単体**検査。
// ⚠ 役割の分担:
//   ・こちら = **組み立てた DOM の形**だけを、`bridge`/`send`/フォーカス制御を一切経由せずに直接撃つ
//     (管理画面のプレビュー=別PRが同じ関数を呼ぶときの契約そのもの)
//   ・`tests/embed-flow.test.ts` = **本体(`draw()`)を通した流れ全体**(計測・フォーカス・排他を含む)
// 既存の `embed-flow.test.ts` / `embed-style.test.ts` は切り出し前からある検査で、
// 切り出し後もそのまま緑(= 挙動を変えていないことの確認)。ここは**新しい単位**(関数そのもの)を
// 直接撃つことで、将来プレビューがこの関数だけを呼んでも同じ契約が保たれることを固定する。
import { describe, expect, it } from "vitest";
import { buildPopupView, DIALOG_LABEL, FALLBACK_BUTTON_LABEL } from "../packages/embed/src/popup-view";

const DESTINATION = "https://offer.example.com/a";

describe("buildPopupView(text型)", () => {
  it("見出し・本文・ボタンを持つパネルを組み立てる", () => {
    const view = buildPopupView(document, {
      kind: "text",
      content: { headline: "まだ間に合います", body: "本文です", buttonLabel: "確認する" },
      destinationUrl: DESTINATION,
    });

    expect(view.panel.className).toBe("panel");
    expect(view.panel.getAttribute("role")).toBe("dialog");
    expect(view.panel.getAttribute("aria-modal")).toBe("true");
    expect(view.shadow.querySelector(".headline")?.textContent).toBe("まだ間に合います");
    expect(view.shadow.querySelector(".body")?.textContent).toBe("本文です");
    expect(view.cta?.textContent).toBe("確認する");
    expect(view.cta?.getAttribute("href")).toBe(DESTINATION);
    expect(view.cta?.rel).toBe("noopener noreferrer");
    expect(view.imageLink).toBeNull();
    expect(view.imageElement).toBeNull();
    // 見出しが名前になる(aria-labelledby)
    expect(view.panel.getAttribute("aria-labelledby")).toBe("adpop-headline");
  });

  it("ボタン文言が空なら既定文言(内部用語ではない仮置き)を使う", () => {
    const view = buildPopupView(document, {
      kind: "text",
      content: { headline: "", body: "", buttonLabel: "" },
      destinationUrl: DESTINATION,
    });
    expect(view.cta?.textContent).toBe(FALLBACK_BUTTON_LABEL);
    // 見出しが無いときはダイアログの既定ラベル
    expect(view.panel.getAttribute("aria-label")).toBe(DIALOG_LABEL);
    expect(view.panel.getAttribute("aria-labelledby")).toBeNull();
  });

  it("本文が空なら <p> を作らない", () => {
    const view = buildPopupView(document, {
      kind: "text",
      content: { headline: "見出し", body: "", buttonLabel: "押す" },
      destinationUrl: DESTINATION,
    });
    expect(view.shadow.querySelector(".body")).toBeNull();
  });

  it("🔴 HTML を入れても textContent にしか入らない(innerHTML を使わない)", () => {
    const view = buildPopupView(document, {
      kind: "text",
      content: { headline: "<img src=x onerror=alert(1)>", buttonLabel: "押す" },
      destinationUrl: DESTINATION,
    });
    expect(view.shadow.querySelector("img")).toBeNull();
    expect(view.shadow.querySelector(".headline")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("文字数の上限を超えた分は切り詰める", () => {
    const view = buildPopupView(document, {
      kind: "text",
      content: { headline: "あ".repeat(400), buttonLabel: "押す" },
      destinationUrl: DESTINATION,
    });
    expect(view.shadow.querySelector(".headline")?.textContent).toHaveLength(300);
  });
});

describe("buildPopupView(image型)", () => {
  it("画像だけのバナー(ボタン文言が空)。画像全体が1つのリンクで、閉じるボタンは独立している", () => {
    const view = buildPopupView(document, {
      kind: "image",
      content: { headline: "", body: "", buttonLabel: "", imageAlt: "秋の新作キャンペーン" },
      destinationUrl: DESTINATION,
    });

    expect(view.panel.className).toBe("panel image-panel");
    expect(view.imageLink?.getAttribute("href")).toBe(DESTINATION);
    expect(view.imageLink?.getAttribute("aria-label")).toBe("秋の新作キャンペーン");
    expect(view.imageElement).not.toBeNull();
    expect(view.imageElement?.getAttribute("src")).toBeNull(); // 🔴 src はまだ付けない(呼び出し側の責務)
    expect(view.imageElement?.alt).toBe("");
    expect(view.shadow.querySelector(".footer")).toBeNull();
    expect(view.cta).toBeNull();
    expect(view.closeButton.className).toBe("close-image");
    expect(view.imageLink?.contains(view.closeButton)).toBe(false);
    expect(view.panel.getAttribute("aria-label")).toBe("秋の新作キャンペーン");
  });

  it("画像+ボタン。画像リンクとボタンは同じ遷移先を指す別々の <a>(入れ子にしない)", () => {
    const view = buildPopupView(document, {
      kind: "image",
      content: { headline: "", body: "", buttonLabel: "友だち追加", imageAlt: "" },
      destinationUrl: DESTINATION,
    });

    expect(view.imageLink?.getAttribute("href")).toBe(DESTINATION);
    expect(view.cta?.getAttribute("href")).toBe(DESTINATION);
    expect(view.imageLink?.contains(view.cta as Node)).toBe(false);
    expect(view.cta?.textContent).toBe("友だち追加");
    // imageAlt が空でもボタン文言があるので、画像リンクの名前はボタン文言に落ちる(空にはしない)
    expect(view.imageLink?.getAttribute("aria-label")).toBe("友だち追加");
  });

  it("見出し・ボタンのどちらも無ければフッターそのものを出さない", () => {
    const view = buildPopupView(document, {
      kind: "image",
      content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" },
      destinationUrl: DESTINATION,
    });
    expect(view.shadow.querySelector(".footer")).toBeNull();
  });
});
