// @vitest-environment node
//
// `scripts/delivery-origin-guard.mjs`(deploy 前に、管理画面へ渡す配信元が、配信 Worker のホストから
// 作った期待値と完全一致しているかを見る検査)の判定そのものを固定する。
// 形(`https://…` であれば通す)では合格にしない: 別のドメインや1文字違いでも通ってしまうため。
import { describe, expect, it } from "vitest";
import { deliveryOriginGuardProblems, expectedDeliveryOrigin } from "../scripts/delivery-origin-guard.mjs";

const HOST = "adpop.example.net";
const EXPECTED = `https://${HOST}`;

describe("expectedDeliveryOrigin", () => {
  it("ホスト名から https:// の配信元を作る", () => {
    expect(expectedDeliveryOrigin(HOST)).toBe(EXPECTED);
  });
  it("ホストが無い・空なら空文字(期待値を作れない)", () => {
    expect(expectedDeliveryOrigin(undefined)).toBe("");
    expect(expectedDeliveryOrigin("")).toBe("");
  });
});

describe("deliveryOriginGuardProblems", () => {
  it("🔴 ①期待値を作れない(配信側にホストが無い)ときは止まる", () => {
    const problems = deliveryOriginGuardProblems({ actualOrigin: EXPECTED, expectedOrigin: "" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("決められない");
  });

  it("🔴 ②1文字違いのときは止まる", () => {
    const problems = deliveryOriginGuardProblems({ actualOrigin: "https://adpop.example.nett", expectedOrigin: EXPECTED });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("一致");
  });

  it("🔴 ③別のドメインのときは止まる", () => {
    expect(
      deliveryOriginGuardProblems({ actualOrigin: "https://other.example.net", expectedOrigin: EXPECTED }).length,
    ).toBeGreaterThan(0);
  });

  it("🔴 ④http:// のときは止まる", () => {
    expect(
      deliveryOriginGuardProblems({ actualOrigin: `http://${HOST}`, expectedOrigin: EXPECTED }).length,
    ).toBeGreaterThan(0);
  });

  it("🔴 ⑤渡されていない(undefined)ときは止まる", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: undefined, expectedOrigin: EXPECTED }).length).toBeGreaterThan(0);
  });

  it("✅ ⑥完全一致のときは通る", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: EXPECTED, expectedOrigin: EXPECTED })).toEqual([]);
  });

  it("✅ ⑦末尾の / だけが違うときは通る(アプリ側も末尾の / を外して使う)", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: `${EXPECTED}/`, expectedOrigin: EXPECTED })).toEqual([]);
  });
});
