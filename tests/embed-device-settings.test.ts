// @vitest-environment node
//
// 端末ごとの表示設定・見た目の**純粋な選択ロジック**を固定する。
//
// ⚠ かつては exit intent(PC のみ)しか実装が無かったため
//   スマホでは `arm()` を経由した E2E 経路を1度も踏めなかった。いまは scroll・dwell が
//   両端末で動く(`tests/embed-flow.test.ts` の「④滞在時間」「②スクロール到達率」が E2E を見る)。
//   → ここは **選択ロジック自体の純粋な検査**(`deviceDisplaySettings`/`deviceVariant`/`readConfig`)
//   として残す(E2E と役割が被らないよう、机上の形の検査に絞る)。
import { describe, expect, it } from "vitest";
import {
  deviceDisplaySettings,
  deviceVariant,
  readConfig,
} from "../packages/embed/src/loader";
import { IMPLEMENTED_TRIGGERS, TRIGGER_DEVICES, type PopupConfig, type Variant } from "../packages/embed/src/bridge";

describe("TRIGGER_DEVICES(実装上の受け皿)", () => {
  it("🔴 exit_intent は PC のみ。ほかは両方(将来そのトリガが実装されたときに備えた値)", () => {
    expect(TRIGGER_DEVICES.exit_intent).toEqual(["desktop"]);
    for (const kind of ["back", "scroll", "idle", "dwell", "visibility"] as const) {
      expect(TRIGGER_DEVICES[kind]).toEqual(["desktop", "mobile"]);
    }
  });

  it("🔴 scroll・dwell が実装側に入っていて、スマホで使えるきっかけは2件になっている", () => {
    const usableOnMobile = IMPLEMENTED_TRIGGERS.filter((kind) => TRIGGER_DEVICES[kind].includes("mobile"));
    expect(usableOnMobile.sort()).toEqual(["dwell", "scroll"]);
  });
});

const basePopup = (mobile?: PopupConfig["mobile"]): PopupConfig => ({
  key: "p".repeat(32),
  minDisplayDelaySeconds: 3,
  frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
  triggers: [{ kind: "exit_intent", threshold: null }],
  variants: [
    {
      key: "v".repeat(32),
      kind: "text",
      weight: 100,
      content: { headline: "PC見出し" },
      destinationUrl: "https://offer.example.com/a",
    },
  ],
  mobile,
});

const baseVariant = (mobile?: Variant["mobile"]): Variant => ({
  key: "v".repeat(32),
  kind: "text",
  weight: 100,
  content: { headline: "PC見出し" },
  destinationUrl: "https://offer.example.com/a",
  mobile,
});

describe("deviceDisplaySettings", () => {
  it("✅ desktop は常に popup 自身の値(mobile があっても無視する)", () => {
    const popup = basePopup({
      minDisplayDelaySeconds: 99,
      frequency: { suppressDays: 1, sessionImpressions: 1, postConversionDays: 1 },
      triggers: [{ kind: "scroll", threshold: 50 }],
    });
    expect(deviceDisplaySettings(popup, "desktop")).toEqual({
      minDisplayDelaySeconds: 3,
      frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
      triggers: [{ kind: "exit_intent", threshold: null }],
    });
  });

  it("🔴 mobile がある応答で mobile 端末なら、その値を使う(PC とは別の値)", () => {
    const mobileSettings: NonNullable<PopupConfig["mobile"]> = {
      minDisplayDelaySeconds: 99,
      frequency: { suppressDays: 1, sessionImpressions: 2, postConversionDays: 3 },
      triggers: [{ kind: "scroll", threshold: 50 }],
    };
    const popup = basePopup(mobileSettings);
    expect(deviceDisplaySettings(popup, "mobile")).toEqual(mobileSettings);
  });

  it("⚠ mobile が無い応答(旧い応答)で mobile 端末でも、PC の値へ落ちる(前の仕様と同じ動き)", () => {
    const popup = basePopup(undefined);
    expect(deviceDisplaySettings(popup, "mobile")).toEqual({
      minDisplayDelaySeconds: 3,
      frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
      triggers: [{ kind: "exit_intent", threshold: null }],
    });
  });

  it("✅ mobile があって全部 PC と同じ値のときは、desktop と mobile で出る値がちょうど同じ", () => {
    const popup = basePopup({
      minDisplayDelaySeconds: 3,
      frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
      triggers: [{ kind: "exit_intent", threshold: null }],
    });
    expect(deviceDisplaySettings(popup, "mobile")).toEqual(deviceDisplaySettings(popup, "desktop"));
  });
});

describe("deviceVariant", () => {
  it("✅ desktop は常に PC の見た目(mobile があっても無視する)", () => {
    const variant = baseVariant({ kind: "image", content: { imageKey: "images/mobile.png" } });
    expect(deviceVariant(variant, "desktop")).toEqual(variant);
  });

  it("🔴 mobile 端末で variant.mobile があれば、kind・content だけ差し替える。destinationUrl・key は PC と共通のまま", () => {
    const variant = baseVariant({ kind: "image", content: { imageKey: "images/mobile.png" } });
    const resolved = deviceVariant(variant, "mobile");
    expect(resolved.kind).toBe("image");
    expect(resolved.content).toEqual({ imageKey: "images/mobile.png" });
    expect(resolved.destinationUrl).toBe(variant.destinationUrl); // 🔴 遷移先は端末で変えない
    expect(resolved.key).toBe(variant.key);
  });

  it("⚠ variant.mobile が無い(旧い応答)なら、mobile 端末でも PC の見た目のまま", () => {
    const variant = baseVariant(undefined);
    expect(deviceVariant(variant, "mobile")).toEqual(variant);
  });
});

describe("readConfig: mobile の形の検査", () => {
  const validBody = (mobileOverride?: unknown) => ({
    v: 1,
    popup: {
      key: "p".repeat(32),
      minDisplayDelaySeconds: 3,
      frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
      triggers: [{ kind: "exit_intent", threshold: null }],
      mobile: mobileOverride,
      variants: [
        {
          key: "v".repeat(32),
          kind: "text",
          weight: 100,
          content: { headline: "a" },
          destinationUrl: "https://offer.example.com/a",
        },
      ],
    },
  });

  it("✅ mobile が無い応答は、今までどおり読める(旧い応答)", () => {
    expect(readConfig(validBody(undefined))).not.toBeNull();
  });

  it("✅ mobile が正しい形なら読める", () => {
    expect(
      readConfig(
        validBody({
          minDisplayDelaySeconds: 3,
          frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
          triggers: [],
        }),
      ),
    ).not.toBeNull();
  });

  it.each([
    ["minDisplayDelaySeconds が数値でない", { minDisplayDelaySeconds: "3", frequency: {}, triggers: [] }],
    ["frequency が無い", { minDisplayDelaySeconds: 3, triggers: [] }],
    ["triggers が配列でない", { minDisplayDelaySeconds: 3, frequency: {}, triggers: "x" }],
    ["mobile 自体がオブジェクトでない", "not-an-object"],
    // 🔴 以下は「オブジェクトであること」までは満たすが、中身が欠けている。
    //   ここまで見ないと、このまま通ってしまう。
    ["frequency がオブジェクトだが中身が空", { minDisplayDelaySeconds: 3, frequency: {}, triggers: [] }],
    [
      "frequency の postConversionDays だけ欠けている",
      { minDisplayDelaySeconds: 3, frequency: { suppressDays: 7, sessionImpressions: 1 }, triggers: [] },
    ],
    [
      "triggers の要素が kind を持たない",
      { minDisplayDelaySeconds: 3, frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 }, triggers: [{ threshold: null }] },
    ],
    [
      "triggers の要素の threshold が文字列",
      {
        minDisplayDelaySeconds: 3,
        frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 },
        triggers: [{ kind: "scroll", threshold: "50" }],
      },
    ],
  ])("🔴 %s → mobile があるのに形が壊れている = 全体を断る(fail-closed)", (_label, mobile) => {
    expect(readConfig(validBody(mobile))).toBeNull();
  });

  it("🔴 variants[].mobile の形が壊れていても全体を断る", () => {
    const body = validBody(undefined);
    (body.popup.variants[0] as Record<string, unknown>).mobile = { kind: 123, content: {} };
    expect(readConfig(body)).toBeNull();
  });

  it("✅ variants[].mobile が正しい形なら読める", () => {
    const body = validBody(undefined);
    (body.popup.variants[0] as Record<string, unknown>).mobile = { kind: "text", content: { headline: "b" } };
    expect(readConfig(body)).not.toBeNull();
  });
});
