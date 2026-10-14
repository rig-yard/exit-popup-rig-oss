import { describe, expect, it } from "vitest";
import { actionsForToggle, applyArchiveResult, applyDeleteResult, applyDeliveryActionResult, applyRestoreResult } from "./popupActions";
import type { ApiPopup } from "./types";

function popup(overrides: Partial<ApiPopup> = {}): ApiPopup {
  return {
    id: "popup-1",
    siteId: "site-1",
    name: "通常CPN",
    status: "paused",
    archivedAt: null,
    suppressDays: 7,
    sessionImpressions: 1,
    postConversionDays: 0,
    minDisplayDelaySeconds: 0,
    ...overrides,
  };
}

describe("actionsForToggle(アーカイブ済みの行をONにできる)", () => {
  it("🔴 アーカイブ済み(archivedAt あり)を activate に → restore→activate の順で呼ぶ", () => {
    const target = popup({ archivedAt: "2026-01-01T00:00:00.000Z", status: "paused" });
    expect(actionsForToggle(target, "activate")).toEqual(["restore", "activate"]);
  });

  it("✅ 非アーカイブを activate に → activate だけ(呼び出しを増やさない)", () => {
    const target = popup({ archivedAt: null, status: "paused" });
    expect(actionsForToggle(target, "activate")).toEqual(["activate"]);
  });

  it("✅ pause は、アーカイブ済みかどうかに関わらず pause だけ", () => {
    expect(actionsForToggle(popup({ archivedAt: "2026-01-01T00:00:00.000Z" }), "pause")).toEqual(["pause"]);
    expect(actionsForToggle(popup({ archivedAt: null }), "pause")).toEqual(["pause"]);
  });
});

describe("applyDeliveryActionResult", () => {
  it("activate: 対象を active にし、同じサイトの他の active は paused にする(サーバーの activatePopup=admin.ts:445-466 と同じ規則。1サイト1つしか稼働できない)", () => {
    const popups = [
      popup({ id: "popup-1", siteId: "site-1", status: "paused" }),
      popup({ id: "popup-2", siteId: "site-1", status: "active" }), // 同じサイトの稼働中
      popup({ id: "popup-3", siteId: "site-1", status: "draft" }), // activeではないので対象外
    ];
    const next = applyDeliveryActionResult(popups, "popup-1", "activate");
    expect(next?.find((p) => p.id === "popup-1")?.status).toBe("active");
    expect(next?.find((p) => p.id === "popup-2")?.status).toBe("paused"); // 🔴 同じサイトのactiveは停止になる
    expect(next?.find((p) => p.id === "popup-3")?.status).toBe("draft"); // 元からactiveでないので変わらない
  });

  it("activate: 別サイトの active には影響しない(サーバーの制約は同じサイト内だけ)", () => {
    const popups = [popup({ id: "popup-1", siteId: "site-1", status: "paused" }), popup({ id: "popup-2", siteId: "site-2", status: "active" })];
    const next = applyDeliveryActionResult(popups, "popup-1", "activate");
    expect(next?.find((p) => p.id === "popup-2")?.status).toBe("active"); // 別サイトなので変わらない
  });

  it("pause: 対象が active のときだけ paused にする。他の行には触れない", () => {
    const popups = [popup({ id: "popup-1", status: "active" }), popup({ id: "popup-2", status: "active" })];
    const next = applyDeliveryActionResult(popups, "popup-1", "pause");
    expect(next?.find((p) => p.id === "popup-1")?.status).toBe("paused");
    expect(next?.find((p) => p.id === "popup-2")?.status).toBe("active"); // 対象外は変わらない
  });

  it("pause: 対象が元から active でない(draft等)場合は何も変えない(サーバーのSQLの case when と同じ)", () => {
    const popups = [popup({ id: "popup-1", status: "draft" })];
    const next = applyDeliveryActionResult(popups, "popup-1", "pause");
    expect(next?.find((p) => p.id === "popup-1")?.status).toBe("draft");
  });

  it("対象のidが存在しない場合、どの行も変わらない(新しい行を作らない)", () => {
    const popups = [popup({ id: "popup-1", status: "paused" })];
    const next = applyDeliveryActionResult(popups, "not-found", "activate");
    expect(next).toEqual(popups);
    expect(next?.length).toBe(1);
  });

  it("popupsがnull(未読み込み)のときはnullのまま返す(落ちない)", () => {
    expect(applyDeliveryActionResult(null, "popup-1", "activate")).toBeNull();
  });

  it("対象以外のフィールド(name・stats系)は書き換えない(同じ参照 or 同じ値)", () => {
    const original = popup({ id: "popup-1", status: "paused", name: "検証A" });
    const next = applyDeliveryActionResult([original], "popup-1", "activate");
    expect(next?.[0]).toEqual({ ...original, status: "active" });
  });
});

describe("applyArchiveResult(サーバーのarchivePopup=admin.ts:415-424と同じ規則)", () => {
  it("archivedAtを立て、statusがactiveだったらpausedにする", () => {
    const popups = [popup({ id: "popup-1", status: "active", archivedAt: null })];
    const next = applyArchiveResult(popups, "popup-1", "2026-10-11T00:00:00.000Z");
    expect(next?.[0].archivedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(next?.[0].status).toBe("paused");
  });

  it("statusがactiveでなければstatusは変えない(draftのまま)", () => {
    const popups = [popup({ id: "popup-1", status: "draft", archivedAt: null })];
    const next = applyArchiveResult(popups, "popup-1", "2026-10-11T00:00:00.000Z");
    expect(next?.[0].status).toBe("draft");
  });

  it("既にarchivedAtが立っていたら上書きしない(サーバーのcoalesceと同じ)", () => {
    const popups = [popup({ id: "popup-1", archivedAt: "2026-01-01T00:00:00.000Z" })];
    const next = applyArchiveResult(popups, "popup-1", "2026-10-11T00:00:00.000Z");
    expect(next?.[0].archivedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("対象外の行には触れない", () => {
    const popups = [popup({ id: "popup-1", status: "active" }), popup({ id: "popup-2", status: "active" })];
    const next = applyArchiveResult(popups, "popup-1", "2026-10-11T00:00:00.000Z");
    expect(next?.find((p) => p.id === "popup-2")?.status).toBe("active");
    expect(next?.find((p) => p.id === "popup-2")?.archivedAt).toBeNull();
  });
});

describe("applyRestoreResult(サーバーのrestorePopup=admin.ts:427-430と同じ規則。statusは変えない)", () => {
  it("archivedAtをnullに戻す。statusはそのまま", () => {
    const popups = [popup({ id: "popup-1", status: "paused", archivedAt: "2026-01-01T00:00:00.000Z" })];
    const next = applyRestoreResult(popups, "popup-1");
    expect(next?.[0].archivedAt).toBeNull();
    expect(next?.[0].status).toBe("paused"); // statusは触っていない
  });
});

describe("applyDeleteResult(サーバーのdeletePopup=admin.ts:433-436と同じ規則。行が消える)", () => {
  it("対象の行を取り除く", () => {
    const popups = [popup({ id: "popup-1" }), popup({ id: "popup-2" })];
    const next = applyDeleteResult(popups, "popup-1");
    expect(next?.map((p) => p.id)).toEqual(["popup-2"]);
  });

  it("popupsがnullのときはnullのまま返す", () => {
    expect(applyDeleteResult(null, "popup-1")).toBeNull();
  });
});
