import { describe, expect, it } from "vitest";
import { persistableDraftOrder, type PersistedCard } from "./popupEditSession";

const FIELDS = { kind: "text" as const, headline: "", body: "", buttonLabel: "", imageAlt: "", destinationUrl: "" };
const CARD: PersistedCard = { baseline: null, fields: FIELDS };

describe("persistableDraftOrder", () => {
  it("🔴 修正の核: draftKeysに残っていても、cardsに持ち分が無いキーは保存対象から外す(そのまま保存すると空の下書き枠が復元される)", () => {
    const draftKeys = ["draft-1", "draft-2"];
    const cards: Record<string, PersistedCard> = { "draft-1": CARD };
    expect(persistableDraftOrder(draftKeys, cards)).toEqual(["draft-1"]);
  });

  it("書き戻された(cardsに再び現れた)キーは、次の呼び出しで自動的にまた含まれる", () => {
    const draftKeys = ["draft-1", "draft-2"];
    const cardsAfterClear: Record<string, PersistedCard> = { "draft-1": CARD };
    expect(persistableDraftOrder(draftKeys, cardsAfterClear)).toEqual(["draft-1"]);

    const cardsAfterWriteBack: Record<string, PersistedCard> = { "draft-1": CARD, "draft-2": CARD };
    expect(persistableDraftOrder(draftKeys, cardsAfterWriteBack)).toEqual(["draft-1", "draft-2"]);
  });

  it("順序はdraftKeysのまま(cardsのキー順に並び替えない)", () => {
    const draftKeys = ["c", "a", "b"];
    const cards: Record<string, PersistedCard> = { a: CARD, b: CARD, c: CARD };
    expect(persistableDraftOrder(draftKeys, cards)).toEqual(["c", "a", "b"]);
  });

  it("空のdraftKeys・空のcardsでも落ちない", () => {
    expect(persistableDraftOrder([], {})).toEqual([]);
  });
});
