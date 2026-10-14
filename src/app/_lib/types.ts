/*
  API が返す値の形(`src/lib/data/admin.ts` の型の写し)。
  ⚠ ここは画面が読むためだけの型。検査の正はサーバー側(body.ts・admin.ts)。
*/
import { LIMITS } from "../../lib/data/limits";

export type ApiSite = { id: string; name: string; siteKey: string; allowedOrigins: string[] };

/** WORKSPACE(owner 1人に1。サイトとは別の単位。Slack と同じ概念)。 */
export type ApiWorkspace = { name: string };

export type ApiPopupStatus = "draft" | "active" | "paused";
export type ApiPopup = {
  id: string;
  siteId: string;
  name: string;
  status: ApiPopupStatus;
  archivedAt: string | null;
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
};

export type ApiTriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";
export type ApiTrigger = { kind: ApiTriggerKind; enabled: boolean; threshold: number | null };

/**
 * サイト単位の表示設定(表示設定ページ。)。
 * 🔴 いまは PC(desktop)の行だけを読み書きする(PC/スマホの切替は画面から
 *   全廃したため)。`mobile` は応答に含まれるが使わない(将来 PC/スマホ別の設定を再検討する場合は
 *   要件側から見直す=)。
 */
export type ApiSiteDeviceDisplay = {
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
  triggers: ApiTrigger[];
};
export type ApiSiteDisplay = { siteId: string; desktop: ApiSiteDeviceDisplay };

export type ApiVariantKind = "text" | "image" | "chatbot";
export type ApiVariantContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageAlt?: unknown;
  imageKey?: unknown;
};
export type ApiVariant = {
  id: string;
  popupId: string;
  kind: ApiVariantKind;
  content: ApiVariantContent;
  destinationUrl: string;
  archivedAt: string | null;
};

// 🔴 サーバー側(`src/lib/data/limits.ts`)と同じ出どころ。値をここで書き直さない。
export const SITE_LIMIT = LIMITS.sites;
export const POPUP_LIMIT = LIMITS.popupsPerSite;
export const VARIANT_LIMIT = LIMITS.variantsPerPopup;

/** `src/admin/body.ts` の parseVariant が受ける形(#8 で `imageAlt` が4つ目の鍵として必須になった)。 */
export type VariantSavePayload = {
  kind: "text" | "image";
  content: { headline: string; body: string; buttonLabel: string; imageAlt: string };
  destinationUrl: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function variantHeadline(v: ApiVariant): string {
  return text(v.content.headline);
}
export function variantBody(v: ApiVariant): string {
  return text(v.content.body);
}
export function variantButtonLabel(v: ApiVariant): string {
  return text(v.content.buttonLabel);
}
export function variantImageAlt(v: ApiVariant): string {
  return text(v.content.imageAlt);
}
export function variantImageKey(v: ApiVariant): string | null {
  const key = v.content.imageKey;
  return typeof key === "string" ? key : null;
}

/**
 * 「配れるか」の判定(archivedAt は見ない。見るのは種類と内容だけ)。
 * `src/lib/data/delivery.ts` の `deliverableVariantSql`(#8)と**同じ正の条件**:
 * テキスト型、または imageKey が設定済みの画像型。chatbot(`ApiVariantKind`に入っているが
 * 未実装)はどちらにも当たらないので false になる——`kind === "image" && imageKey === null` の
 * 否定だけを見ると、chatbot を「配れる」側に誤って含めてしまう。
 */
export function isDeliverableKind(kind: ApiVariantKind, imageKey: string | null): boolean {
  return kind === "text" || (kind === "image" && imageKey !== null);
}

/** 「配信中」タグの判定。非アーカイブ・かつ `isDeliverableKind` を満たす最初のパターン。 */
export function deliverableVariantId(variants: ApiVariant[]): string | null {
  const candidate = variants.find((v) => v.archivedAt === null && isDeliverableKind(v.kind, variantImageKey(v)));
  return candidate?.id ?? null;
}
