/*
  配信の2つの口(設定を返す・計測イベントを入れる)。**配信の Worker が DB に触るのは、この2関数を通してだけ**
  (worker.ts が import しているのはこの2つ。D1 のメソッドを直接呼んでいないことは tests/d1-access-boundary.test.ts)。

  旧版(PostgreSQL)では `adpop_site_config` / `adpop_record_event`(security definer の関数)が持っていた判定を、
  TypeScript に移した。旧版の検査のうち D1 でも意味があるものを移して、同じ理由で断ることを確かめた
  (`tests/d1-delivery.test.ts`。移していないものはその冒頭)。
  ⚠ 違いを1つ知っている: 表示 ID は「ハイフン付き・16進」の形だけを受ける(旧版の uuid 型は `{…}` やハイフン無しも受けた)。

  🔴 **fail-closed**: サイトキー・Origin・許可ドメイン・稼働中のポップ・配れるバリアントの
    どれか1つでも欠けたら `null` / `not_allowed`。**サイトの不在と Origin の不一致を区別しない。**
  🔴 **返す情報を最小に**: 内部 id・owner_id・他サイトの情報を返さない。`content` は名指しした鍵だけ。
  🔴 **所有者を呼び出し側から指定させない**: 書く行の owner_id / site_id は、サイトキーから引いた行の値だけを使う。
  ⚠ D1 のバインドはネットワークに出ていないので、旧版の「関数を直接叩いてルートの守りを迂回する」経路は無い。
    判定は Worker のコード(ここと入口の src/lib/api/http.ts)にしか無く、旧版のように DB 側にもう1枚置いてはいない。
*/
import type { D1Database } from "@cloudflare/workers-types";
import { isHex32, isOrigin, isUuid, normalizePageUrl } from "./shapes";
import type { Bindings } from "./source";

/** 本文の上限(旧版と同じ 4096 バイト)。⚠ ルートは回線のバイト、ここは正規化した JSON のバイトを数える。 */
export const MAX_EVENT_JSON_BYTES = 4096;

const TRIGGER_ORDER = ["back", "scroll", "idle", "dwell", "visibility", "exit_intent"] as const;
const RECEIVABLE_KINDS = ["fire", "suppressed", "impression", "click", "close"] as const;

/**
 * スマホ用に解決済みの値。🔴 **「PC と同じ」はここで解決してから返す** ——
 *   `same_as_pc` / `custom` の区別はローダに渡さない(ローダは知らなくてよい=軽く保つ)。
 */
export type MobilePopupConfig = {
  minDisplayDelaySeconds: number;
  frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
  triggers: Array<{ kind: string; threshold: number | null }>;
};

export type MobileVariantConfig = { kind: string; content: Record<string, unknown> };

export type SiteConfig = {
  v: 1;
  popup: {
    key: string;
    minDisplayDelaySeconds: number;
    frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
    triggers: Array<{ kind: string; threshold: number | null }>;
    /** 🔴 足しただけ(既存の項目は PC の値のまま)。古いローダはこの鍵を知らず、無視して今までどおり動く。 */
    mobile: MobilePopupConfig;
    variants: Array<{
      key: string;
      kind: string;
      weight: number;
      content: Record<string, unknown>;
      destinationUrl: string;
      mobile: MobileVariantConfig;
    }>;
  };
};

/*
  🔴 稼働中のポップを「サイトキー × 許可ドメイン」から引く副問い合わせ。**複数の問い合わせが同じ条件を使う。**
    ⚠ `limit 1` は選択ではなく検算(稼働中は1サイト1つ = 一意索引)。
*/
const ACTIVE_POPUP = `
  select p.id from popups p
  join sites s on s.id = p.site_id
  join site_allowed_origins o on o.site_id = s.id and o.origin = ?2
  where s.site_key = ?1 and p.status = 'active'
  limit 1`;

/**
 * 🔴 表示設定(きっかけ・頻度)は**サイト単位**になった。
 *   `popups` の頻度の列・`popup_triggers`・0004 の `popup_mobile_display` / `popup_mobile_triggers` は
 *   **凍結**——この配信の口を含め、`src/` のどこからも読まない(値の出どころはすべて
 *   `site_display_settings` / `site_display_triggers` に替える。`admin.ts` と同じ付け替え)。
 *   稼働中のポップの `site_id` を経由して引く(ポップは1サイト複数あるが、表示設定はサイトに1組)。
 */
const ACTIVE_SITE = `(select site_id from popups where id = (${ACTIVE_POPUP}))`;

type PopupRow = { public_key: string };
/** ⚠ `id` は内部 id(スマホ用上書きの突き合わせにだけ使う)。応答には積まない(下の変換で捨てる)。 */
type VariantRow = { id: string; public_key: string; kind: string; weight: number; content: string; destination_url: string };

/*
  ── サイト単位の表示設定(0005)────────────────────
  🔴 `device = 'desktop'` の行が**今までの PC の値**、`device = 'mobile'` の行が
    「PC と同じ」を解決する前のスマホの値。解決(`same_as_pc` → desktop の値を使う)はここで行い、
    ローダへは渡さない。
*/
type SiteDisplaySettingsRow = {
  device: "desktop" | "mobile";
  triggers_mode: "same_as_pc" | "custom" | null;
  frequency_mode: "same_as_pc" | "custom" | null;
  suppress_days: number;
  session_impressions: number;
  post_conversion_days: number;
  min_display_delay_seconds: number;
};
type SiteTriggerRow = { device: "desktop" | "mobile"; kind: string; threshold: number | null };
/*
  ── デザイン(パターンのスマホ用の上書き)。ポップごとのまま(サイト単位の対象外) ──
*/
type MobileVariantDesignRow = { variant_id: string; mode: "same_as_pc" | "custom"; kind: "text" | "image" | null; content: string };

/**
 * 表示に要る鍵だけを名指しで取り出す(`content` を丸ごと渡さない)。null と欠けた鍵は落とす。
 * 🔴 **`imageKey` / `imageAlt` を足した**。画像型の配信に要る——
 *   埋め込みの本体(`packages/embed/src/runtime.ts`)が描くのに使うのは、この関数が返す鍵だけ。
 *   ⚠ ここに無い鍵(`internalNote` 等)は、DB に何が入っていても配信の応答に出ない
 *     (`tests/d1-delivery.test.ts` の「出てよい鍵の集合ちょうど」)。
 */
function pickContent(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["headline", "body", "buttonLabel", "imageKey", "imageAlt"]) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

/**
 * 配信の Worker が受け取るバインド。🔴 **Worker は D1 の値そのものに触らず、この入れ物ごと渡す**
 *   (データ層の外で D1 の値を参照していないことを `tests/d1-access-boundary.test.ts` が型で見る)。
 */
export type DeliveryBindings = Bindings;

export class MissingDatabaseError extends Error {
  constructor() {
    super("D1 binding `DB` is missing");
    this.name = "MissingDatabaseError";
  }
}

/** バインドが在るか(無い = 運用の設定の問題。Worker は 503 にする)。 */
export function hasDatabase(env: DeliveryBindings): boolean {
  return env.DB !== undefined;
}

function database(env: DeliveryBindings): D1Database {
  if (env.DB === undefined) throw new MissingDatabaseError();
  return env.DB;
}

/** サイトキー + Origin → いま有効なポップの設定。合わなければ `null`(fail-closed)。 */
export async function siteConfig(env: DeliveryBindings, siteKey: string, origin: string): Promise<SiteConfig | null> {
  if (!isHex32(siteKey) || !isOrigin(origin)) return null;
  const db = database(env);

  // ⚠ batch は1つのトランザクション。すべての読み取りが同じ時点を見る(サイトの desktop・mobile の
  //   どちらも、パターンのデザインも、1回のスナップショットから出す)。
  const [popupResult, variantResult, siteSettingsResult, siteTriggerResult, mobileDesignResult] = await db.batch([
    db.prepare(`select public_key from popups where id = (${ACTIVE_POPUP})`).bind(siteKey, origin),
    /*
      ⚠ 配らないもの: アーカイブ済み / 画像が未設定の画像型(アップロードしていない=配っても壊れたポップになる)/
        🕐 chatbot(v1.1)。「配れる」の定義は `admin.ts` の稼働の切り替えと同じ(DELIVERABLE_VARIANT)。
      ⚠ 並びは決定的だが「作った順」とは限らない(同じ時刻の行は id の順)。将来の割り当てはこの並びに依存させない。
      ⚠ **配れるかどうかは PC 側だけで決まる**。スマホのデザインの状態は見ない。
    */
    db
      .prepare(
        `select id, public_key, kind, weight, content, destination_url from variants
         where popup_id = (${ACTIVE_POPUP}) and ${DELIVERABLE_VARIANT}
         order by created_at, id`,
      )
      .bind(siteKey, origin),
    // 🔴 サイトの表示設定(desktop・mobile の2行)。
    db
      .prepare(
        `select device, triggers_mode, frequency_mode, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds
         from site_display_settings where site_id = ${ACTIVE_SITE}`,
      )
      .bind(siteKey, origin),
    // 🔴 サイトの12トリガのうち enabled = 1 の分だけ(desktop・mobile の両方を1クエリで取り、下で分ける)。
    db
      .prepare(`select device, kind, threshold from site_display_triggers where enabled = 1 and site_id = ${ACTIVE_SITE}`)
      .bind(siteKey, origin),
    /*
      🔴 **配れるパターンの分だけ読む**(以前はこの稼働中ポップの全パターン(アーカイブ済みを
        含む)を毎回読んでいた。アーカイブ→作成を繰り返すほど行数が増え、この設定取得は `cache: "no-store"`
        で毎リクエスト走る=無制限に重くなる経路になっていた)。
      ⚠ **「配れるかどうか」の判定そのものは variants(PC 側)だけで決まる**という不変条件は変えない
        ——ここは variantResult と**同じ条件**(`DELIVERABLE_VARIANT` の別名版)を
        スマホ用デザインの行にも適用して、読む範囲を同じ集合に揃えているだけ。
    */
    db
      .prepare(
        `select vmd.variant_id, vmd.mode, vmd.kind, vmd.content
         from variant_mobile_designs vmd
         join variants v on v.id = vmd.variant_id
         where v.popup_id = (${ACTIVE_POPUP}) and ${deliverableVariantSql("v")}`,
      )
      .bind(siteKey, origin),
  ]);

  const popup = (popupResult.results as PopupRow[])[0];
  if (popup === undefined) return null;
  const variants = variantResult.results as VariantRow[];
  if (variants.length === 0) return null;

  const sortTriggers = (rows: Array<{ kind: string; threshold: number | null }>) =>
    rows
      .slice()
      .sort(
        (a, b) =>
          TRIGGER_ORDER.indexOf(a.kind as (typeof TRIGGER_ORDER)[number]) -
          TRIGGER_ORDER.indexOf(b.kind as (typeof TRIGGER_ORDER)[number]),
      )
      .map((t) => ({ kind: t.kind, threshold: t.threshold }));

  const settingsRows = siteSettingsResult.results as SiteDisplaySettingsRow[];
  const triggerRows = siteTriggerResult.results as SiteTriggerRow[];
  const desktopSettings = settingsRows.find((r) => r.device === "desktop");
  const mobileSettings = settingsRows.find((r) => r.device === "mobile");
  // 🔴 サイトを作った時点で DB のトリガが desktop・mobile の2行を入れる(0005)。desktop が無ければ
  //   データの不整合 —— 値の出どころが無いので、推測で埋めずに fail-closed(トリガの保証を信用しすぎない)。
  if (desktopSettings === undefined) return null;

  const pcTriggers = sortTriggers(triggerRows.filter((t) => t.device === "desktop"));
  const pcFrequency = {
    suppressDays: desktopSettings.suppress_days,
    sessionImpressions: desktopSettings.session_impressions,
    postConversionDays: desktopSettings.post_conversion_days,
  };

  // 🔴 「PC と同じ」の解決。`mobile` 行が無い(移行漏れ等の想定外)ときも same_as_pc と同じ扱いにする。
  const mobileTriggersCustom = sortTriggers(triggerRows.filter((t) => t.device === "mobile"));
  const mobile: MobilePopupConfig = {
    minDisplayDelaySeconds:
      mobileSettings?.frequency_mode === "custom" ? mobileSettings.min_display_delay_seconds : desktopSettings.min_display_delay_seconds,
    frequency:
      mobileSettings?.frequency_mode === "custom"
        ? {
            suppressDays: mobileSettings.suppress_days,
            sessionImpressions: mobileSettings.session_impressions,
            postConversionDays: mobileSettings.post_conversion_days,
          }
        : pcFrequency,
    triggers: mobileSettings?.triggers_mode === "custom" ? mobileTriggersCustom : pcTriggers,
  };

  const mobileDesigns = new Map(
    (mobileDesignResult.results as MobileVariantDesignRow[]).map((row) => [row.variant_id, row]),
  );

  return {
    v: 1,
    popup: {
      key: popup.public_key,
      minDisplayDelaySeconds: desktopSettings.min_display_delay_seconds,
      frequency: pcFrequency,
      triggers: pcTriggers,
      mobile,
      variants: variants.map((v) => {
        const pcContent = pickContent(v.content);
        const design = mobileDesigns.get(v.id);
        const mobileVariant: MobileVariantConfig =
          design?.mode === "custom"
            ? { kind: design.kind as string, content: pickContent(design.content) }
            : { kind: v.kind, content: pcContent };
        return {
          key: v.public_key,
          kind: v.kind,
          weight: v.weight,
          content: pcContent,
          destinationUrl: v.destination_url,
          mobile: mobileVariant,
        };
      }),
    },
  };
}

/**
 * 配信に載るバリアントの条件(SQL の断片)を組み立てる。**配信と稼働の切り替えが同じ1つを使う。**
 * 🔴 **画像型は `imageKey` が入っているものだけ配る**(「画像が未設定の画像パターンは
 *   配信しない」)。アップロードしていない画像パターンを配ると、埋め込みの本体が描けずに
 *   壊れたポップを出すか(2枚目の関門で)何も出さないことになる——どちらも「出せる」と見せかけるだけ無駄。
 * @param alias テーブルの別名(省略時は無印。相関サブクエリで別名を付けた `variants` を指すときに使う
 *   = `admin.ts` の「稼働中のポップから配信できる最後のパターンを奪う操作を断る」ガードが使う)
 */
export function deliverableVariantSql(alias?: string): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${col("archived_at")} is null and (${col("kind")} = 'text' or (${col("kind")} = 'image' and json_extract(${col("content")}, '$.imageKey') is not null))`;
}

/** 無印(別名無し)の形。既存の呼び出し側はこのまま使う。 */
export const DELIVERABLE_VARIANT = deliverableVariantSql();

export type RecordOutcome = { ok: true; stored: boolean } | { ok: false; reason: string };

/**
 * 計測イベントを1件入れる。
 * 🔴 **サイトキーと Origin の断りは `not_allowed` の1つにまとめる**(旧版と同じ)
 *   (サイトキーの実在を呼び出し側が判別できないように)。その後の理由(popup / variant / 形)は、
 *   そのサイトの認可を通った後なので分けて返す。
 */
export async function recordEvent(
  env: DeliveryBindings,
  siteKey: string,
  origin: string,
  event: Record<string, unknown>,
): Promise<RecordOutcome> {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return { ok: false, reason: "event" };
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_JSON_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  // 🔴 値は全部 JSON の文字列(数値や真偽値を文字列として通さない)
  if (Object.values(event).some((value) => typeof value !== "string")) return { ok: false, reason: "types" };
  const field = (name: string): string | null => {
    const value = event[name] as string | undefined;
    return value === undefined || value === "" ? null : value;
  };

  if (!isHex32(siteKey) || !isOrigin(origin)) return { ok: false, reason: "not_allowed" };
  const db = database(env);
  const site = await db
    .prepare(
      `select s.id, s.owner_id from sites s
       join site_allowed_origins o on o.site_id = s.id and o.origin = ?2
       where s.site_key = ?1`,
    )
    .bind(siteKey, origin)
    .first<{ id: string; owner_id: string }>();
  if (site === null) return { ok: false, reason: "not_allowed" };

  // 🔴 ポップとバリアントは「公開用の識別子 → そのサイト配下」でしか解決しない(内部 id を受け取らない)
  const popup = await db
    .prepare(`select id from popups where site_id = ?1 and public_key = ?2`)
    .bind(site.id, field("popupKey") ?? "")
    .first<{ id: string }>();
  if (popup === null) return { ok: false, reason: "popup" };

  let variantId: string | null = null;
  const variantKey = field("variantKey");
  if (variantKey !== null) {
    const variant = await db
      .prepare(`select id from variants where popup_id = ?1 and public_key = ?2`)
      .bind(popup.id, variantKey)
      .first<{ id: string }>();
    if (variant === null) return { ok: false, reason: "variant" };
    variantId = variant.id;
  }

  const pageUrl = normalizePageUrl(event.pageUrl);
  if (!pageUrl.ok) return { ok: false, reason: "pageUrl" };

  const visitor = field("visitorHash");
  if (visitor !== null && !isHex32(visitor)) return { ok: false, reason: "visitorHash" };

  const impressionId = field("impressionId");
  if (impressionId !== null && !isUuid(impressionId.toLowerCase())) return { ok: false, reason: "impressionId" };

  const kind = field("kind");
  // 🔴 `conversion` はここでは受けない(CV 計測は別の入口にする予定で、未実装)
  if (kind === null || !(RECEIVABLE_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "kind" };

  try {
    const result = await db
      .prepare(
        `insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind,
                             impression_id, visitor_hash, device, close_reason, page_url)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         on conflict (site_id, impression_id, kind) where kind in ('impression', 'close') do nothing`,
      )
      .bind(
        site.owner_id,
        site.id,
        popup.id,
        variantId,
        kind,
        field("triggerKind"),
        impressionId === null ? null : impressionId.toLowerCase(),
        visitor,
        field("device"),
        field("closeReason"),
        pageUrl.value,
      )
      .run();
    // 🔴 重複排除で入らなかったのは「失敗」ではない(stored = false)
    return { ok: true, stored: result.meta.changes === 1 };
  } catch (error) {
    // 形の制約(CHECK / 外部キー / NOT NULL)に当たった。⚠ どの制約かは返さない
    if (error instanceof Error && error.message.includes("SQLITE_CONSTRAINT")) return { ok: false, reason: "shape" };
    // 🔴 それ以外(DB に届かない等)は「形が悪い」にしない。呼び出し側が 502 にする
    throw error;
  }
}
