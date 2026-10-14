// 「配れるか」の判定。
// サーバーの deliverableVariantSql(src/lib/data/delivery.ts)と同じ正の条件で書けているかを固定する。
import { describe, expect, it } from "vitest";
import { deliverableVariantId, isDeliverableKind, type ApiVariant } from "./types";

function variant(overrides: Partial<ApiVariant> = {}): ApiVariant {
  return {
    id: "v1",
    popupId: "p1",
    kind: "text",
    content: {},
    destinationUrl: "https://example.com/",
    archivedAt: null,
    ...overrides,
  };
}

describe("isDeliverableKind", () => {
  it("✅ テキスト型は常に配れる(画像の有無を見ない)", () => {
    expect(isDeliverableKind("text", null)).toBe(true);
    expect(isDeliverableKind("text", "images/" + "a".repeat(32) + ".png")).toBe(true);
  });

  it("✅ 画像型はimageKeyがあるときだけ配れる", () => {
    expect(isDeliverableKind("image", "images/" + "a".repeat(32) + ".png")).toBe(true);
    expect(isDeliverableKind("image", null)).toBe(false);
  });

  it("🔴 chatbot(ApiVariantKindに入っているが未実装)はどちらにも当たらず配れない", () => {
    // 🔴 以前の実装は `kind === "image" && imageKey === null` の否定だけを見ていたため、
    //   chatbot(imageKeyを持たない)を誤って「配れる」側に含めてしまっていた。
    expect(isDeliverableKind("chatbot", null)).toBe(false);
  });
});

describe("deliverableVariantId", () => {
  it("非アーカイブ・配れる条件を満たす最初のパターンのidを返す", () => {
    const variants = [
      variant({ id: "archived-text", kind: "text", archivedAt: "2026-01-01T00:00:00.000Z" }),
      variant({ id: "image-no-key", kind: "image", content: {}, archivedAt: null }),
      variant({ id: "deliverable-text", kind: "text", archivedAt: null }),
    ];
    expect(deliverableVariantId(variants)).toBe("deliverable-text");
  });

  it("🔴 配れるパターンが1つも無ければ null(0件とnullを混同しない呼び出し側の責務は呼び出し元にある)", () => {
    const variants = [
      variant({ id: "archived", kind: "text", archivedAt: "2026-01-01T00:00:00.000Z" }),
      variant({ id: "chatbot", kind: "chatbot", archivedAt: null }),
      variant({ id: "image-no-key", kind: "image", content: {}, archivedAt: null }),
    ];
    expect(deliverableVariantId(variants)).toBeNull();
  });
});
