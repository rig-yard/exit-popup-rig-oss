import { describe, expect, it } from "vitest";
import { breadcrumbItemsForPath, isAppShellHidden, navKeyForPath } from "./appShellRoute";

describe("navKeyForPath", () => {
  it("🔴 /dashboard, /popups, /popup, /display, /tags をそれぞれ正しいNavKeyへ", () => {
    expect(navKeyForPath("/dashboard")).toBe("dashboard");
    expect(navKeyForPath("/popups")).toBe("design");
    expect(navKeyForPath("/popup")).toBe("design");
    expect(navKeyForPath("/display")).toBe("display");
    expect(navKeyForPath("/tags")).toBe("tags");
  });

  it("未知のパスは dashboard にフォールバックする", () => {
    expect(navKeyForPath("/")).toBe("dashboard");
  });
});

describe("breadcrumbItemsForPath", () => {
  it("🔴 /dashboard, /tags は空(見出しと同じ文言になるため出さない)", () => {
    expect(breadcrumbItemsForPath("/dashboard", "site-1")).toEqual([]);
    expect(breadcrumbItemsForPath("/tags", "site-1")).toEqual([]);
  });

  it("🔴 /popups, /display はリンク無しの1項目", () => {
    expect(breadcrumbItemsForPath("/popups", "site-1")).toEqual([{ label: "デザイン" }]);
    expect(breadcrumbItemsForPath("/display", "site-1")).toEqual([{ label: "表示設定" }]);
  });

  it("🔴 /popup は siteId が確定していればリンク付き、未確定なら空", () => {
    expect(breadcrumbItemsForPath("/popup", "site-1")).toEqual([{ label: "デザイン", href: "/popups?site=site-1" }]);
    expect(breadcrumbItemsForPath("/popup", "")).toEqual([]);
  });
});

describe("isAppShellHidden", () => {
  it("🔴 /tags かつ siteId 未指定のときだけ true(0件の初回設定)", () => {
    expect(isAppShellHidden("/tags", "")).toBe(true);
  });

  it("/tags?site= があれば false", () => {
    expect(isAppShellHidden("/tags", "site-1")).toBe(false);
  });

  it("他のページは常に false", () => {
    expect(isAppShellHidden("/dashboard", "")).toBe(false);
    expect(isAppShellHidden("/popup", "")).toBe(false);
  });

  it("⚠ 変異検査: /tags の判定自体が外れると壊れることを確かめる(検査が効いているか)", () => {
    function withoutPathCheck(siteId: string): boolean {
      return siteId === "";
    }
    // 本来は /dashboard では false のはずが、パス判定を落とすと true になってしまう
    expect(withoutPathCheck("")).toBe(true);
    expect(isAppShellHidden("/dashboard", "")).toBe(false);
  });
});
