// @vitest-environment jsdom
//
// 管理画面のプレビュー。`buildPopupPreview` が実際に:
//  ① ページの枠・暗い背景(.backdrop)を描かない ② リンクをクリックしても遷移しない
//  ③ 渡した画像URLをそのまま<img>に付ける ④ inert/aria-hiddenで操作・読み上げの対象から外す
// ことを固定する。
import { describe, expect, it } from "vitest";
import { buildPopupPreview, type PopupPreviewInput } from "./popupPreview";

function baseInput(overrides: Partial<PopupPreviewInput> = {}): PopupPreviewInput {
  return {
    kind: "text",
    headline: "今だけ送料無料",
    body: "今注文すると送料が無料になります。",
    buttonLabel: "詳しく見る",
    imageAlt: "",
    destinationUrl: "https://yomogi-tsuhan.example.com/campaign",
    imageUrl: null,
    ...overrides,
  };
}

describe("buildPopupPreview(テキスト型)", () => {
  it("🔴 .backdrop は消さずに残す(font-family/line-height/colorはここにしか無い)。" +
    "固定配置・暗い背景・最前面だけを無効化する", () => {
    const { host } = buildPopupPreview(document, baseInput());
    const shadow = host.shadowRoot!;
    const backdrop = shadow.querySelector(".backdrop") as HTMLElement;
    expect(backdrop, ".backdropごと消していないか").not.toBeNull();
    const panel = shadow.querySelector(".panel");
    expect(panel).not.toBeNull();
    // .panel の親は .backdrop(フォント等を継承できる状態のまま)
    expect((panel as Element).parentElement).toBe(backdrop);
    // 固定配置・ページ全面の暗い背景は、専用クラス(.preview-flat)で打ち消されている
    // (インラインstyleは書かない。CSPのstyle-src対策)
    expect(backdrop.classList.contains("preview-flat")).toBe(true);
    expect(backdrop.getAttribute("style")).toBeNull();
  });

  it("入力した見出し・本文・ボタン文言がそのまま描かれる", () => {
    const { host } = buildPopupPreview(document, baseInput({ headline: "秋の新作", body: "本文です", buttonLabel: "見る" }));
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector(".headline")?.textContent).toBe("秋の新作");
    expect(shadow.querySelector(".body")?.textContent).toBe("本文です");
    expect(shadow.querySelector(".cta")?.textContent).toBe("見る");
  });

  it("🔴 CTA をクリックしても遷移しない(preventDefault される)", () => {
    const { host } = buildPopupPreview(document, baseInput());
    const cta = host.shadowRoot!.querySelector(".cta") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    cta.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("host は inert かつ aria-hidden(クリック・タブ移動・読み上げの対象にしない)", () => {
    const { host } = buildPopupPreview(document, baseInput());
    expect(host.hasAttribute("inert")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
  });

  it("destroy() はイベントリスナーを外す(呼んだ後は defaultPrevented にならない)", () => {
    const { host, destroy } = buildPopupPreview(document, baseInput());
    const cta = host.shadowRoot!.querySelector(".cta") as HTMLAnchorElement;
    destroy();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    cta.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("buildPopupPreview(画像型)", () => {
  it("🔴 渡した画像URL(配信元 or blob:)がそのまま <img src> に入る", () => {
    const { host } = buildPopupPreview(document, baseInput({ kind: "image", imageUrl: "blob:http://localhost/abc" }));
    const img = host.shadowRoot!.querySelector(".image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:http://localhost/abc");
  });

  it("画像URLが無ければ src 属性を付けない(壊れた画像アイコンを出さない)", () => {
    const { host } = buildPopupPreview(document, baseInput({ kind: "image", imageUrl: null }));
    const img = host.shadowRoot!.querySelector(".image") as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);
  });

  it("🔴 画像リンク(.image-link)をクリックしても遷移しない", () => {
    const { host } = buildPopupPreview(document, baseInput({ kind: "image", imageUrl: "blob:http://localhost/abc" }));
    const link = host.shadowRoot!.querySelector(".image-link") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("destinationUrl が空のとき", () => {
  it("href に空文字を書かない(\"#\" にする。自己リンクに見えるのを避ける)", () => {
    const { host } = buildPopupPreview(document, baseInput({ destinationUrl: "" }));
    const cta = host.shadowRoot!.querySelector(".cta") as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("#");
  });
});
