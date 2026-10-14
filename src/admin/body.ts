/*
  管理画面の API の本文の検査(副作用なし)。
  🔴 **未知の鍵を断る**(`content` に `imageKey` を混ぜて送る、などを入口で止める)。
    ⚠ 止めるのは入口の1枚目。データ層も `content` を3欄から組み直す(2枚目)。
  ⚠ 形の正(Origin・https)は `src/lib/data/shapes.ts`。ここは呼び出すだけ。
*/
import { isValidThreshold, TEXT_LIMITS, type TriggerKind } from "../../packages/embed/src/bridge";
import type { VariantInput } from "../lib/data/admin";
import { isHttpsUrl, isOrigin, requiresImageAlt } from "../lib/data/shapes";

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const NAME_MAX = 200;
const SMALLINT_MAX = 32767;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 鍵の集合がちょうど `keys` であること(足りない・余る、のどちらも断る)。 */
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= NAME_MAX;
}

export function parseLogin(body: unknown): Parsed<{ email: string; password: string }> {
  if (!exactKeys(body, ["email", "password"])) return { ok: false, field: "body" };
  if (typeof body.email !== "string" || body.email.length > 254) return { ok: false, field: "email" };
  if (typeof body.password !== "string" || body.password.length > 256) return { ok: false, field: "password" };
  return { ok: true, value: { email: body.email, password: body.password } };
}

export function parseSite(body: unknown): Parsed<{ name: string; allowedOrigins: string[] }> {
  if (!exactKeys(body, ["name", "allowedOrigins"])) return { ok: false, field: "body" };
  if (!name(body.name)) return { ok: false, field: "name" };
  const origins = body.allowedOrigins;
  if (!Array.isArray(origins) || origins.length > 20 || !origins.every(isOrigin)) {
    return { ok: false, field: "allowedOrigins" };
  }
  return { ok: true, value: { name: body.name.trim(), allowedOrigins: origins as string[] } };
}

export function parseName(body: unknown): Parsed<{ name: string }> {
  if (!exactKeys(body, ["name"])) return { ok: false, field: "body" };
  if (!name(body.name)) return { ok: false, field: "name" };
  return { ok: true, value: { name: body.name.trim() } };
}

const FREQUENCY_KEYS = ["suppressDays", "sessionImpressions", "postConversionDays", "minDisplayDelaySeconds"] as const;

export function parseFrequency(
  body: unknown,
): Parsed<{ suppressDays: number; sessionImpressions: number; postConversionDays: number; minDisplayDelaySeconds: number }> {
  if (!exactKeys(body, FREQUENCY_KEYS)) return { ok: false, field: "body" };
  for (const key of FREQUENCY_KEYS) {
    const v = body[key];
    const min = key === "sessionImpressions" ? 1 : 0;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > SMALLINT_MAX) return { ok: false, field: key };
  }
  return {
    ok: true,
    value: {
      suppressDays: body.suppressDays as number,
      sessionImpressions: body.sessionImpressions as number,
      postConversionDays: body.postConversionDays as number,
      minDisplayDelaySeconds: body.minDisplayDelaySeconds as number,
    },
  };
}

export function parseTrigger(body: unknown): Parsed<{ enabled: boolean }> {
  if (!exactKeys(body, ["enabled"]) || typeof body.enabled !== "boolean") return { ok: false, field: "enabled" };
  return { ok: true, value: { enabled: body.enabled } };
}

/**
 * トリガの閾値。**範囲は `kind` ごとに違う**(`scroll`=到達率%、`dwell`=秒)ので
 *   `kind` を引数に取る。
 * 🔴 **`isValidThreshold`(`bridge.ts`)をそのまま使う** —— 範囲・整数かどうかの判定を2か所に書いて
 *   食い違わせない(ローダの描画前の検査=`resolveThreshold` と同じ関数を読む。`TEXT_LIMITS` を
 *   `parseVariant` が読むのと同じやり方)。
 */
export function parseThreshold(kind: TriggerKind, body: unknown): Parsed<{ threshold: number | null }> {
  if (!exactKeys(body, ["threshold"])) return { ok: false, field: "threshold" };
  const value = body.threshold;
  if (!isValidThreshold(kind, value)) return { ok: false, field: "threshold" };
  return { ok: true, value: { threshold: value } };
}

export function parseVariant(body: unknown): Parsed<VariantInput> {
  if (!exactKeys(body, ["kind", "content", "destinationUrl"])) return { ok: false, field: "body" };
  if (body.kind !== "text" && body.kind !== "image") return { ok: false, field: "kind" };
  const content = body.content;
  if (!exactKeys(content, ["headline", "body", "buttonLabel", "imageAlt"])) return { ok: false, field: "content" };
  for (const key of ["headline", "body", "buttonLabel", "imageAlt"] as const) {
    const v = content[key];
    if (typeof v !== "string" || v.length > TEXT_LIMITS[key]) return { ok: false, field: key };
  }
  if (!isHttpsUrl(body.destinationUrl)) return { ok: false, field: "destinationUrl" };
  const buttonLabel = (content.buttonLabel as string).trim();
  const imageAlt = (content.imageAlt as string).trim();
  const value: VariantInput = {
    kind: body.kind,
    content: {
      headline: (content.headline as string).trim(),
      body: (content.body as string).trim(),
      buttonLabel,
      imageAlt,
    },
    destinationUrl: body.destinationUrl,
  };
  /*
    🔴 **画像の説明は、画像型かつボタン文言が空のときだけ必須**。
      ⚠ **1枚目の関門**(入口)。`src/lib/data/admin.ts` の `requiresImageAlt` を**そのまま import して使う**
      ——定義を2か所に複製しない(片方だけ直して欠落値への fail-open が
      再発することを防ぐ)。2枚目(データ層での再チェック)も同じ関数を呼ぶ。
  */
  if (requiresImageAlt(value)) return { ok: false, field: "imageAlt" };
  return { ok: true, value };
}

/* ─────────────── PC / スマホ別の表示設定・デザイン ─────────────── */

export function parseMobileMode(body: unknown): Parsed<{ mode: "same_as_pc" | "custom" }> {
  if (!exactKeys(body, ["mode"]) || (body.mode !== "same_as_pc" && body.mode !== "custom")) {
    return { ok: false, field: "mode" };
  }
  return { ok: true, value: { mode: body.mode } };
}

/**
 * スマホの個別デザインの保存。`parseVariant` と同じ4欄だが **`destinationUrl` を持たない**
 *  (「遷移先 URL は PC と共通」)。`imageAlt` の必須条件(画像型かつボタン文言が空)は
 *  `requiresImageAlt` をそのまま呼ぶ(定義を複製しない。`parseVariant` と同じ理由)。
 */
export type MobileDesignBody = { kind: "text" | "image"; content: { headline: string; body: string; buttonLabel: string; imageAlt: string } };

export function parseMobileDesign(body: unknown): Parsed<MobileDesignBody> {
  if (!exactKeys(body, ["kind", "content"])) return { ok: false, field: "body" };
  if (body.kind !== "text" && body.kind !== "image") return { ok: false, field: "kind" };
  const content = body.content;
  if (!exactKeys(content, ["headline", "body", "buttonLabel", "imageAlt"])) return { ok: false, field: "content" };
  for (const key of ["headline", "body", "buttonLabel", "imageAlt"] as const) {
    const v = content[key];
    if (typeof v !== "string" || v.length > TEXT_LIMITS[key]) return { ok: false, field: key };
  }
  const value: MobileDesignBody = {
    kind: body.kind,
    content: {
      headline: (content.headline as string).trim(),
      body: (content.body as string).trim(),
      buttonLabel: (content.buttonLabel as string).trim(),
      imageAlt: (content.imageAlt as string).trim(),
    },
  };
  if (requiresImageAlt(value)) return { ok: false, field: "imageAlt" };
  return { ok: true, value };
}

/** 物理削除の確認(数字も消える)。本文は `{"confirm":"delete"}` ちょうど。 */
export function parseDeleteConfirm(body: unknown): Parsed<null> {
  if (!exactKeys(body, ["confirm"]) || body.confirm !== "delete") return { ok: false, field: "confirm" };
  return { ok: true, value: null };
}

/** 本文の無い変更(稼働・停止・アーカイブ・ログアウト)。本文は `{}` ちょうど。 */
export function parseEmpty(body: unknown): Parsed<null> {
  if (!exactKeys(body, [])) return { ok: false, field: "body" };
  return { ok: true, value: null };
}
