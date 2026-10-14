/*
  管理画面のデータ層。**所有者(owner)の分離はここが持つ**(旧版の RLS の代わり)。

  🔴 **規則**(①③④は検査が直接見る。②は検査が「振る舞い」で見る = 他人として呼ぶと):
    ① 公開する関数は**すべて第2引数に `ownerId` を取る**(`tests/d1-owner-isolation.test.ts` が全関数を列挙し、
       他人の owner で呼ぶと「0件 / 見つからない」になることを撃つ。**一覧に無い関数を足すと検査が落ちる**)
    ② 読み取り・更新・削除の SQL は **`owner_id = ?` を必ず条件に入れる**
    ③ 挿入は、親への**複合外部キー (親の id, owner_id)** が他人の親を指す行を断る(DB が最後に判定する)
    ④ D1 のバインドに触ってよいのは `src/lib/data/` の中だけ(`tests/d1-access-boundary.test.ts`)
  ⚠ **守れなくなったもの**: DB が最後の砦ではない。この層のコードの誤り1つで他人の行に届く
    (旧版は RLS が誤りを止めた)。v1 は管理者1人なので、実害の範囲は狭い(README)。
  ⚠ 結果の「0件」は失敗として返す(`not_found`)。成功に見せない。
*/
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { DELIVERABLE_VARIANT, deliverableVariantSql } from "./delivery";
import { resolveDb, type DbSource } from "./source";
import { classifyD1Error, type DataFailure } from "./errors";
import { isHttpsUrl, isImageKey, isOrigin, requiresImageAlt } from "./shapes";

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      failure:
        | DataFailure
        | { kind: "not_found" }
        | { kind: "invalid"; field: string }
        | { kind: "no_deliverable_variant" }
        | { kind: "last_deliverable_variant" }
        // 🔴 スマホの表示設定・デザインを「個別に設定する(custom)」にしていないのに、
        //   個別の値を直接書き換えようとしたとき(same_as_pc のときの書き込みは API が断る方針)
        | { kind: "not_custom" }
        // 🔴 「個別に設定する」への切り替え中に、PC の画像が複写元のキーから差し替わっていた
        //   (複写とこの書き込みの間に PC の画像が入れ替わるレース)。
        //   呼び出し側は複写した新しいキーを消し直し待ちに積んで drain し、ここでは書かない。
        //   再試行(もう一度 PC を読み直してから複写し直す)は呼び出し側に委ねる。
        | { kind: "stale_pc_image" };
    };

export type PopupStatus = "draft" | "active" | "paused";
export type TriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";
export type VariantKind = "text" | "image";
/** きっかけ・頻度(表示設定)の対象端末(サイト単位)。 */
export type Device = "desktop" | "mobile";

export type Site = { id: string; name: string; siteKey: string; allowedOrigins: string[] };
export type Popup = {
  id: string;
  siteId: string;
  name: string;
  status: PopupStatus;
  archivedAt: string | null;
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
};
export type Trigger = { kind: TriggerKind; enabled: boolean; threshold: number | null };
export type Variant = {
  id: string;
  popupId: string;
  kind: "text" | "image" | "chatbot";
  content: Record<string, unknown>;
  destinationUrl: string;
  archivedAt: string | null;
};

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function notFound<T>(): Result<T> {
  return { ok: false, failure: { kind: "not_found" } };
}
function invalid<T>(field: string): Result<T> {
  return { ok: false, failure: { kind: "invalid", field } };
}

/** 書き込みを実行し、D1 の断りを分類して返す。⚠ 分類できない失敗(DB に届かない等)は投げ直す。 */
async function write<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (error) {
    const failure = classifyD1Error(error);
    if (failure.kind === "unknown") throw error;
    return { ok: false, failure };
  }
}

function changed(result: { meta: { changes: number } }): boolean {
  return result.meta.changes > 0;
}

function parseContent(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/* ─────────────── 所有者 ─────────────── */

/** 所有者の行を用意する(認証がログイン時に呼ぶ)。既に在れば何もしない。 */
export async function ensureOwner(source: DbSource, ownerId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return write(async () => {
    await db.prepare(`insert into owners (id) values (?1) on conflict (id) do nothing`).bind(ownerId).run();
    return null;
  });
}

/*
  ─────────────── WORKSPACE(0007。owner 1人につきちょうど1行) ───────────────
  🔴 サイト(sites.name)とは別のデータ。「管理画面を使うチーム・組織の単位」で、v1 は owner=WORKSPACE。
    `owners_seed_workspace`(0007)が新規 owner に既定値「Workspace」を入れ、既存 owner は
    0007 の backfill が最初のサイトの名前(無ければ「Workspace」)で埋めている。
*/
export type Workspace = { name: string };

type WorkspaceRow = { name: string };

export async function getWorkspace(source: DbSource, ownerId: string): Promise<Result<Workspace>> {
  const db = resolveDb(source);
  const row = await db.prepare(`select name from workspaces where owner_id = ?1`).bind(ownerId).first<WorkspaceRow>();
  if (row === null) return notFound();
  return ok({ name: row.name });
}

export async function updateWorkspaceName(source: DbSource, ownerId: string, name: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await write(() =>
    db.prepare(`update workspaces set name = ?2, updated_at = ${NOW} where owner_id = ?1`).bind(ownerId, name).run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}


/*
  ─────────────── 画像の後始末の「先に積む」(write-ahead) ───────────────
  🔴 画像の参照を外す・行を消す DB の操作と**同じ batch(1つの取引)の中で、先に** `pending_image_deletions` に積む。
    batch が落ちれば、参照も積んだ行も**一緒に巻き戻る**(どちらか片方だけ残らない)。
    R2 から消すのは batch の後(`images.ts`)。消せたら積んだ行を消す。消せなければ行が残り、次に消し直す。
  ⚠ 積む INSERT の失敗は握り潰さない(batch ごと失敗して、呼び出し側へ例外が届く)。
*/
type DeleteScope = { siteId: string } | { popupId: string } | { variantId: string };

/**
 * その範囲の(アーカイブ済みを含む)全パターンの画像のキーを、所有者の条件つきで `pending_image_deletions` に積む文。
 * 🔴 **`extraCondition` は、同じ取引の `deleteStatement` が断られたときに、この INSERT だけが
 *   実行されてしまわないようにするためのもの**。`deleteVariant` は
 *   「稼働中のポップから最後の配信可能パターンを奪う削除」を WHERE で断る(`keepsDeliverableGuard`)が、
 *   このガードは DELETE の文だけに掛かっていて、**同じ batch の INSERT(ここ)は無条件で実行されていた**
 *   —— 断られた削除でも画像キーが積まれ、`cleanupPending` とログに偽の未処理削除が出ていた。
 *   ⚠ `siteId`/`popupId` 範囲(deleteSite/deletePopup)には対応するガードが無い(断る操作ではない)ので、
 *   既定は空文字列のまま変えない。
 * 🔴 `variants.content` だけでなく `variant_mobile_designs.content` の画像キーも UNION で集める
 *   見落とすと、ポップ・パターン・サイトの削除(cascade)でスマホの画像が
 *   R2 に残り続ける(公開バケットに宙に浮いたファイル)。`extraCondition`/`column` はどちらの枝でも
 *   同じ束縛パラメータ・同じエイリアス(`v`=variants・`p`=popups)を指すので、そのまま両方の枝に付けられる。
 */
function enqueueImagesUnder(db: D1Database, ownerId: string, scope: DeleteScope, extraCondition = ""): D1PreparedStatement {
  const [column, value] =
    "siteId" in scope ? ["p.site_id", scope.siteId] : "popupId" in scope ? ["v.popup_id", scope.popupId] : ["v.id", scope.variantId];
  return db
    .prepare(
      `insert into pending_image_deletions (key, owner_id)
       select json_extract(v.content, '$.imageKey'), v.owner_id from variants v
       join popups p on p.id = v.popup_id
       where v.owner_id = ?1 and ${column} = ?2 and json_extract(v.content, '$.imageKey') is not null
         ${extraCondition}
       union
       select json_extract(m.content, '$.imageKey'), v.owner_id from variant_mobile_designs m
       join variants v on v.id = m.variant_id
       join popups p on p.id = v.popup_id
       where v.owner_id = ?1 and ${column} = ?2 and json_extract(m.content, '$.imageKey') is not null
         ${extraCondition}`,
    )
    .bind(ownerId, value);
}

/** 同じ範囲のキーを読む文(R2 から消すときに使う)。🔴 スマホの個別デザインの画像キーも集める。 */
function selectImagesUnder(db: D1Database, ownerId: string, scope: DeleteScope): D1PreparedStatement {
  const [column, value] =
    "siteId" in scope ? ["p.site_id", scope.siteId] : "popupId" in scope ? ["v.popup_id", scope.popupId] : ["v.id", scope.variantId];
  return db
    .prepare(
      `select json_extract(v.content, '$.imageKey') as key from variants v
       join popups p on p.id = v.popup_id
       where v.owner_id = ?1 and ${column} = ?2 and json_extract(v.content, '$.imageKey') is not null
       union
       select json_extract(m.content, '$.imageKey') as key from variant_mobile_designs m
       join variants v on v.id = m.variant_id
       join popups p on p.id = v.popup_id
       where v.owner_id = ?1 and ${column} = ?2 and json_extract(m.content, '$.imageKey') is not null`,
    )
    .bind(ownerId, value);
}

export type Deleted = { queuedImageKeys: string[] };

async function deleteWithQueue(
  db: D1Database,
  ownerId: string,
  scope: DeleteScope,
  deleteStatement: D1PreparedStatement,
  /**
   * 0件だった理由を「他人・存在しない」以外にも分けたいときに渡す(変更しなければ `not_found` のまま)。
   * ⚠ 今のところ使うのは `deleteVariant`(稼働中のポップから最後の配信可能パターンを奪う削除を断る)だけ。
   */
  onZeroChanges: () => Promise<Result<Deleted>> = async () => notFound(),
  /**
   * 🔴 **`enqueueImagesUnder` に足す条件**。`deleteStatement` が
   *   ガードで断るときは、**同じ条件をここにも渡す**——渡さないと、削除は0件のままなのに
   *   画像キーだけが `pending_image_deletions` に積まれる(断った操作が内部状態を変えてしまう)。
   */
  enqueueExtraCondition = "",
): Promise<Result<Deleted>> {
  const [keys, , deleted] = await db.batch([
    selectImagesUnder(db, ownerId, scope),
    enqueueImagesUnder(db, ownerId, scope, enqueueExtraCondition),
    deleteStatement,
  ]);
  if (deleted.meta.changes === 0) {
    /*
      ⚠ 消す行が無かった(他人の行・既に無い・またはガードが断った)。
      🔴 **積んだ行も無い**: `enqueueExtraCondition` に
      `deleteStatement` と同じガードを渡しているときは、INSERT もここで0件のまま確定する
      (同じ batch = 同じ取引なので、他の文が何を書いても一緒にコミットされるだけで、
      INSERT 自身の WHERE が偽なら元々0行)。
    */
    return onZeroChanges();
  }
  return ok({ queuedImageKeys: (keys.results as Array<{ key: unknown }>).map((r) => r.key).filter(isImageKey) });
}

/* ─────────────── サイト ─────────────── */

type SiteRow = { id: string; name: string; site_key: string };

async function originsOf(db: D1Database, ownerId: string, siteIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return map;
  const rows = await db
    .prepare(
      `select site_id, origin from site_allowed_origins
       where owner_id = ?1 and site_id in (select value from json_each(?2))
       order by origin`,
    )
    .bind(ownerId, JSON.stringify(siteIds))
    .all<{ site_id: string; origin: string }>();
  for (const row of rows.results) map.get(row.site_id)?.push(row.origin);
  return map;
}

export async function listSites(source: DbSource, ownerId: string): Promise<Result<Site[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select id, name, site_key from sites where owner_id = ?1 order by created_at, id`)
    .bind(ownerId)
    .all<SiteRow>();
  const origins = await originsOf(db, ownerId, rows.results.map((r) => r.id));
  return ok(
    rows.results.map((r) => ({ id: r.id, name: r.name, siteKey: r.site_key, allowedOrigins: origins.get(r.id) ?? [] })),
  );
}

export async function getSite(source: DbSource, ownerId: string, siteId: string): Promise<Result<Site>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select id, name, site_key from sites where id = ?1 and owner_id = ?2`)
    .bind(siteId, ownerId)
    .first<SiteRow>();
  if (row === null) return notFound();
  const origins = await originsOf(db, ownerId, [row.id]);
  return ok({ id: row.id, name: row.name, siteKey: row.site_key, allowedOrigins: origins.get(row.id) ?? [] });
}

function checkOrigins(origins: string[]): boolean {
  return origins.every((origin) => isOrigin(origin));
}

function insertOrigins(db: D1Database, ownerId: string, siteId: string, origins: string[]): D1PreparedStatement[] {
  return [...new Set(origins)].map((origin) =>
    db
      .prepare(`insert into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, ?3)`)
      .bind(siteId, ownerId, origin),
  );
}

export async function createSite(
  source: DbSource,
  ownerId: string,
  input: { name: string; allowedOrigins: string[] },
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  if (!checkOrigins(input.allowedOrigins)) return invalid("allowedOrigins");
  const id = crypto.randomUUID();
  // ⚠ batch は1つのトランザクション。サイトと許可ドメインは両方入るか、両方入らない
  return write(async () => {
    await db.batch([
      db
        .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, ?3, ?4)`)
        .bind(id, ownerId, input.name, randomHex(16)),
      ...insertOrigins(db, ownerId, id, input.allowedOrigins),
    ]);
    return { id };
  });
}

/**
 * サイト名と許可ドメインを置き換える。
 * 🔴 許可ドメインの消去と追加は**所有者の条件つき**で、1つのトランザクションで行う。
 *   他人のサイトを指すと、名前の更新は0件・消去も0件・追加は複合外部キーが断る。
 */
export async function updateSite(
  source: DbSource,
  ownerId: string,
  siteId: string,
  input: { name: string; allowedOrigins: string[] },
): Promise<Result<null>> {
  const db = resolveDb(source);
  if (!checkOrigins(input.allowedOrigins)) return invalid("allowedOrigins");
  const exists = await db.prepare(`select 1 from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId).first();
  if (exists === null) return notFound();
  return write(async () => {
    await db.batch([
      db
        .prepare(`update sites set name = ?1, updated_at = ${NOW} where id = ?2 and owner_id = ?3`)
        .bind(input.name, siteId, ownerId),
      db.prepare(`delete from site_allowed_origins where site_id = ?1 and owner_id = ?2`).bind(siteId, ownerId),
      ...insertOrigins(db, ownerId, siteId, input.allowedOrigins),
    ]);
    return null;
  });
}

/**
 * 物理削除。⚠ 配下のポップ・パターン・**数字(events)も消える**(cascade)。確認は画面の責任。
 * 🔴 配下の(アーカイブ済みを含む)全パターンの画像のキーを、**同じ取引で先に**消し直し待ちに積む。
 */
export async function deleteSite(source: DbSource, ownerId: string, siteId: string): Promise<Result<Deleted>> {
  const db = resolveDb(source);
  return deleteWithQueue(db, ownerId, { siteId }, db.prepare(`delete from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId));
}

/* ─────────────── ポップ ─────────────── */

type PopupRow = {
  id: string;
  site_id: string;
  name: string;
  status: PopupStatus;
  archived_at: string | null;
  suppress_days: number;
  session_impressions: number;
  post_conversion_days: number;
  min_display_delay_seconds: number;
};

/*
  🔴 **凍結**: `popups` の頻度の列(`suppress_days` 等)はもう読まない。
    表示設定はサイト単位になったので、ポップの頻度は
    **そのポップのサイトの `site_display_settings`(`device = 'desktop'`)の行**から読む。
    `popups` 側の同名の列は値が残ったまま更新もされなくなる(凍結。`tests/frozen-tables.test.ts` が見る)。
*/
const POPUP_WITH_DESKTOP_DISPLAY = `
  select p.id as id, p.site_id as site_id, p.name as name, p.status as status, p.archived_at as archived_at,
         d.suppress_days as suppress_days, d.session_impressions as session_impressions,
         d.post_conversion_days as post_conversion_days, d.min_display_delay_seconds as min_display_delay_seconds
  from popups p
  join site_display_settings d on d.site_id = p.site_id and d.owner_id = p.owner_id and d.device = 'desktop'
`;

function toPopup(r: PopupRow): Popup {
  return {
    id: r.id,
    siteId: r.site_id,
    name: r.name,
    status: r.status,
    archivedAt: r.archived_at,
    suppressDays: r.suppress_days,
    sessionImpressions: r.session_impressions,
    postConversionDays: r.post_conversion_days,
    minDisplayDelaySeconds: r.min_display_delay_seconds,
  };
}

export async function listPopups(source: DbSource, ownerId: string, siteId: string): Promise<Result<Popup[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`${POPUP_WITH_DESKTOP_DISPLAY} where p.site_id = ?1 and p.owner_id = ?2 order by p.created_at, p.id`)
    .bind(siteId, ownerId)
    .all<PopupRow>();
  return ok(rows.results.map(toPopup));
}

export async function getPopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<Popup>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`${POPUP_WITH_DESKTOP_DISPLAY} where p.id = ?1 and p.owner_id = ?2`)
    .bind(popupId, ownerId)
    .first<PopupRow>();
  return row === null ? notFound() : ok(toPopup(row));
}

/** ⚠ 他人のサイトを指すと、複合外部キー (site_id, owner_id) が断る(`foreign_key`)。 */
export async function createPopup(
  source: DbSource,
  ownerId: string,
  siteId: string,
  input: { name: string },
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  const id = crypto.randomUUID();
  return write(async () => {
    await db
      .prepare(`insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, ownerId, siteId, randomHex(16), input.name)
      .run();
    return { id };
  });
}

async function updatePopup(
  db: D1Database,
  ownerId: string,
  popupId: string,
  set: string,
  values: unknown[],
): Promise<Result<null>> {
  const result = await write(() =>
    db
      .prepare(`update popups set ${set}, updated_at = ${NOW} where id = ?1 and owner_id = ?2`)
      .bind(popupId, ownerId, ...values)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

export function renamePopup(source: DbSource, ownerId: string, popupId: string, name: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "name = ?3", [name]);
}

/**
 * ポップ編集画面の「頻度」。🔴 **付け替え済み**: 書く先はもう `popups` の列ではなく、
 *   **そのポップのサイトの `site_display_settings`(`device = 'desktop'`)の行**。
 *   画面・呼び出し方は変えない——「画面はポップの列に書くが、配信はサイトの表を読む」食い違いを作らないため。
 */
export async function updateFrequency(
  source: DbSource,
  ownerId: string,
  popupId: string,
  input: { suppressDays: number; sessionImpressions: number; postConversionDays: number; minDisplayDelaySeconds: number },
): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await write(() =>
    db
      .prepare(
        `update site_display_settings set
           suppress_days = ?3, session_impressions = ?4, post_conversion_days = ?5, min_display_delay_seconds = ?6,
           updated_at = ${NOW}
         where device = 'desktop' and owner_id = ?2
           and site_id = (select site_id from popups where id = ?1 and owner_id = ?2)`,
      )
      .bind(popupId, ownerId, input.suppressDays, input.sessionImpressions, input.postConversionDays, input.minDisplayDelaySeconds)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

export function pausePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "status = case when status = 'active' then 'paused' else status end", []);
}

/** アーカイブ(配信から外す・数字は残す)。⚠ 稼働中のままはアーカイブできない(CHECK)ので同じ更新で停止にする。 */
export function archivePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(
    db,
    ownerId,
    popupId,
    `archived_at = coalesce(archived_at, ${NOW}), status = case when status = 'active' then 'paused' else status end`,
    [],
  );
}

/** アーカイブから戻す。⚠ 戻すとサイトあたりの上限を超えるなら DB のトリガが断る(`limit`)。 */
export function restorePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "archived_at = null", []);
}

/** 物理削除。⚠ **数字(events)も消える**(cascade)。確認は画面の責任。 */
export async function deletePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<Deleted>> {
  const db = resolveDb(source);
  return deleteWithQueue(db, ownerId, { popupId }, db.prepare(`delete from popups where id = ?1 and owner_id = ?2`).bind(popupId, ownerId));
}

/**
 * 稼働にする。**同じサイトの稼働中は停止になる**(1サイト1つ)。
 * 🔴 2つの更新を1つのトランザクション(batch)で行い、**両方に同じ条件**
 *   (自分のポップ・アーカイブしていない・配れるパターンがある)を書く。
 *   D1 は1つのデータベースのクエリを1つずつ処理するので、条件は2つの文の間で変わらない
 *   → 条件が偽なら**どちらの文も何も変えない**(「止めたが動かせなかった」を作らない)。
 */
export async function activatePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const eligible = `
    select 1 from popups target
    where target.id = ?1 and target.owner_id = ?2 and target.archived_at is null
      and exists (select 1 from variants where popup_id = target.id and ${DELIVERABLE_VARIANT})`;
  const result = await write(() =>
    db.batch([
      db
        .prepare(
          `update popups set status = 'paused', updated_at = ${NOW}
           where owner_id = ?2 and status = 'active' and id <> ?1
             and site_id = (select site_id from popups where id = ?1 and owner_id = ?2)
             and exists (${eligible})`,
        )
        .bind(popupId, ownerId),
      db
        .prepare(`update popups set status = 'active', updated_at = ${NOW} where id = ?1 and owner_id = ?2 and exists (${eligible})`)
        .bind(popupId, ownerId),
    ]),
  );
  if (!result.ok) return result;
  if (result.value[1].meta.changes === 1) return ok(null);
  // なぜ動かせなかったかを分けて返す(自分のポップで、アーカイブしていないなら「配れるパターンが無い」)
  const popup = await db
    .prepare(`select archived_at from popups where id = ?1 and owner_id = ?2`)
    .bind(popupId, ownerId)
    .first<{ archived_at: string | null }>();
  if (popup === null || popup.archived_at !== null) return notFound();
  return { ok: false, failure: { kind: "no_deliverable_variant" } };
}

/* ─────────────── トリガ ─────────────── */

/**
 * ポップ編集画面の「出すきっかけ」(PC)。🔴 **付け替え済み**: 読む先はもう
 *   `popup_triggers` ではなく、**そのポップのサイトの `site_display_triggers`(`device = 'desktop'`)**
 *   画面・呼び出し方は変えない。
 */
export async function listTriggers(source: DbSource, ownerId: string, popupId: string): Promise<Result<Trigger[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(
      `select t.kind as kind, t.enabled as enabled, t.threshold as threshold
       from site_display_triggers t
       where t.device = 'desktop' and t.owner_id = ?2
         and t.site_id = (select site_id from popups where id = ?1 and owner_id = ?2)`,
    )
    .bind(popupId, ownerId)
    .all<{ kind: TriggerKind; enabled: number; threshold: number | null }>();
  return ok(rows.results.map((r) => ({ kind: r.kind, enabled: r.enabled === 1, threshold: r.threshold })));
}

/** 同じ付け替え。書く先は `site_display_triggers`(`device = 'desktop'`)。 */
export async function setTriggerEnabled(
  source: DbSource,
  ownerId: string,
  popupId: string,
  kind: TriggerKind,
  enabled: boolean,
): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await db
    .prepare(
      `update site_display_triggers set enabled = ?1, updated_at = ${NOW}
       where device = 'desktop' and kind = ?4 and owner_id = ?3
         and site_id = (select site_id from popups where id = ?2 and owner_id = ?3)`,
    )
    .bind(enabled ? 1 : 0, popupId, ownerId, kind)
    .run();
  return changed(result) ? ok(null) : notFound();
}

/* ─────────────── パターン(バリアント) ─────────────── */

type VariantRow = {
  id: string;
  popup_id: string;
  kind: Variant["kind"];
  content: string;
  destination_url: string;
  archived_at: string | null;
};
const VARIANT_COLUMNS = "id, popup_id, kind, content, destination_url, archived_at";

function toVariant(r: VariantRow): Variant {
  return {
    id: r.id,
    popupId: r.popup_id,
    kind: r.kind,
    content: parseContent(r.content),
    destinationUrl: r.destination_url,
    archivedAt: r.archived_at,
  };
}

export async function listVariants(source: DbSource, ownerId: string, popupId: string): Promise<Result<Variant[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select ${VARIANT_COLUMNS} from variants where popup_id = ?1 and owner_id = ?2 order by created_at, id`)
    .bind(popupId, ownerId)
    .all<VariantRow>();
  return ok(rows.results.map(toVariant));
}

export async function getVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<Variant>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select ${VARIANT_COLUMNS} from variants where id = ?1 and owner_id = ?2`)
    .bind(variantId, ownerId)
    .first<VariantRow>();
  return row === null ? notFound() : ok(toVariant(row));
}

export type VariantInput = {
  kind: VariantKind;
  content: { headline: string; body: string; buttonLabel: string; imageAlt: string };
  destinationUrl: string;
};

/**
 * 🔴 `content` の JSON は**4欄から自分で組み直す**(呼び出し側のオブジェクトを `stringify` しない)。
 *   型は4欄でも、実行時には何でも通る。そのまま入れると `imageKey` を外から書けた。
 *   `imageKey` を書けるのは `setVariantImage` だけ。
 */
function textContent(input: { content?: { headline?: unknown; body?: unknown; buttonLabel?: unknown; imageAlt?: unknown } }): string {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return JSON.stringify({
    headline: text(input.content?.headline),
    body: text(input.content?.body),
    buttonLabel: text(input.content?.buttonLabel),
    imageAlt: text(input.content?.imageAlt),
  });
}

/*
  🔴 `requiresImageAlt` は `./shapes.ts` にある。
    `src/admin/body.ts`(1枚目の関門)とここ(2枚目)が**同じ関数**を呼ぶことで、定義の重複による
    fail-open の再発を防ぐ。`admin.ts` に置かないのは、DB に触らないこの純粋関数を export すると
    `tests/d1-owner-isolation.test.ts`(「データ層の公開関数はすべて `ownerId` を2番目に取る」を
    機械で検査する)を無関係に壊すため。
*/

/*
  ─────────────── 稼働中のポップから「配信できる最後のパターン」を奪わせない ───────────────
  🔴 **画像を外す・アーカイブする・削除する・(画像の無い画像型へ)編集する**の4つの操作は、
    稼働中(`status = 'active'`)のポップを配信 0 件のまま放置しうる。**黙って停止に切り替えず、操作そのものを断る**
    (押した操作と違う結果になるため)。
  🔴 **判定は書き込みと同じ1つの文の WHERE に埋め込む**(先に読んでから書く、ではない)。
    activatePopup と同じ形: 条件が偽なら変更が0件のまま終わり、呼び出し側が「なぜ変わらなかったか」を後から1回読む。
*/

/**
 * ガードの断片。**ALLOW = そのポップが稼働中でない OR この行以外に配信できる行がある。**
 * ⚠ 「この行自身が操作後も配信できるままか」は呼び出し側が個別に緩める
 *   (archive/delete は、この行が必ず非配信になる操作なのでこれだけで足りる。
 *   `setVariantImage` の画像を外す・`updateVariant` の kind 変更は、**この行の kind・前の状態次第で
 *   「変えても配信できるままの場合」がある**(例: text 型の `imageKey` を外しても配信判定に影響しない)ので、
 *   呼び出し側で OR を足す。足さないと、text 型のこのケースを誤って断ってしまう)。
 * 🔴 **対象行の指し方は、列名(`id` 等)ではなく束縛パラメータ(`?1` 等)で渡す。**
 *   当初は `variants.id` のようにテーブル名で相関させていたが、この断片を `insert ... select`
 *   (対象の `variants` 行が FROM に出てこない文)に挿すと `no such column: variants.popup_id` で落ちた
 *   (実測。D1/SQLite はその文脈で `variants` を解決できない)。さらに `UPDATE`/`DELETE` 内の素の
 *   `where id = id` のような自己参照は、入れ子のサブクエリの中では**内側の `variants` に取られて
 *   常に真になる**(シャドーイング)。**束縛パラメータはテーブルのスコープを持たない**ので、
 *   `update`・`delete`・`insert ... select` のどこに挿しても、何階層ネストしても意味がずれない。
 * @param variantIdParam 呼び出し元の文で対象の variant id を束縛しているプレースホルダ(例 `"?1"`)。
 */
function keepsDeliverableGuard(variantIdParam: string): string {
  return `(
    not exists (
      select 1 from popups p join variants v on v.popup_id = p.id
      where v.id = ${variantIdParam} and p.status = 'active'
    )
    or exists (
      select 1 from variants other
      where other.popup_id = (select popup_id from variants where id = ${variantIdParam})
        and other.id <> ${variantIdParam}
        and ${deliverableVariantSql("other")}
    )
  )`;
}

/**
 * 書き込みが0件のとき、「他人・存在しない」か「ガードが断った」かを**書き込みの後に1回だけ**読み分ける
 * (activatePopup と同じ形。判定そのもの=許可するかどうかは書き込みの WHERE で既に確定しており、
 *  ここは理由を分けて返すためだけの読み取り)。
 */
async function notFoundOrBlocked(
  db: D1Database,
  ownerId: string,
  variantId: string,
): Promise<{ ok: false; failure: { kind: "not_found" } | { kind: "last_deliverable_variant" } }> {
  const exists = await db.prepare(`select 1 from variants where id = ?1 and owner_id = ?2`).bind(variantId, ownerId).first();
  return exists === null ? { ok: false, failure: { kind: "not_found" } } : { ok: false, failure: { kind: "last_deliverable_variant" } };
}


/** ⚠ 他人のポップを指すと、複合外部キー (popup_id, owner_id) が断る(`foreign_key`)。 */
export async function createVariant(
  source: DbSource,
  ownerId: string,
  popupId: string,
  input: VariantInput,
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  if (!isHttpsUrl(input.destinationUrl)) return invalid("destinationUrl");
  if (requiresImageAlt(input)) return invalid("imageAlt");
  const id = crypto.randomUUID();
  return write(async () => {
    await db
      .prepare(
        `insert into variants (id, owner_id, popup_id, public_key, kind, content, destination_url)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(id, ownerId, popupId, randomHex(16), input.kind, textContent(input), input.destinationUrl)
      .run();
    return { id };
  });
}

/**
 * パターンの編集。⚠ **計測はリセットしない**。
 * 文字の3欄だけを差し替える。**画像のキー(`imageKey`)は元の値を残す**(書けるのは `setVariantImage` だけ)。
 */
export async function updateVariant(
  source: DbSource,
  ownerId: string,
  variantId: string,
  input: VariantInput,
): Promise<Result<null>> {
  const db = resolveDb(source);
  if (!isHttpsUrl(input.destinationUrl)) return invalid("destinationUrl");
  if (requiresImageAlt(input)) return invalid("imageAlt");
  const result = await write(() =>
    db
      .prepare(
        `update variants set kind = ?1,
           content = case when json_extract(content, '$.imageKey') is null then ?2
                          else json_set(?2, '$.imageKey', json_extract(content, '$.imageKey')) end,
           destination_url = ?3, updated_at = ${NOW}
         where id = ?4 and owner_id = ?5
           and (
             ?1 = 'text'
             or (?1 = 'image' and json_extract(content, '$.imageKey') is not null)
             or ${keepsDeliverableGuard("?4")}
           )`,
      )
      .bind(input.kind, textContent(input), input.destinationUrl, variantId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  return notFoundOrBlocked(db, ownerId, variantId);
}

async function setVariantArchived(
  db: D1Database,
  ownerId: string,
  variantId: string,
  archived: boolean,
): Promise<Result<null>> {
  const result = await write(() =>
    db
      .prepare(
        `update variants set archived_at = ${archived ? `coalesce(archived_at, ${NOW})` : "null"}, updated_at = ${NOW}
         where id = ?1 and owner_id = ?2
           ${archived ? `and ${keepsDeliverableGuard("?1")}` : ""}`,
      )
      .bind(variantId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  return archived ? notFoundOrBlocked(db, ownerId, variantId) : notFound();
}

export function archiveVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return setVariantArchived(db, ownerId, variantId, true);
}

/** ⚠ 戻すとポップあたりの上限を超えるなら DB のトリガが断る(`limit`)。 */
export function restoreVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return setVariantArchived(db, ownerId, variantId, false);
}

/** 物理削除。⚠ **数字(events)も消える**(cascade)。確認は画面の責任。 */
export async function deleteVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<Deleted>> {
  const db = resolveDb(source);
  return deleteWithQueue(
    db,
    ownerId,
    { variantId },
    db
      .prepare(`delete from variants where id = ?1 and owner_id = ?2 and ${keepsDeliverableGuard("?1")}`)
      .bind(variantId, ownerId),
    () => notFoundOrBlocked(db, ownerId, variantId),
    // 🔴 `enqueueImagesUnder` の `{variantId}` スコープは `?1`=ownerId・`?2`=variantId で束縛する
    //   (DELETE 文とは束縛の順が違うので、ガードに渡すプレースホルダも `?2` にする)。
    `and ${keepsDeliverableGuard("?2")}`,
  );
}

/* ─────────────── 計測の数字(表示・クリック・閉じた) ─────────────── */

export type EventCounts = { impression: number; click: number; close: number };
export type PopupStats = { sevenDay: EventCounts; lifetime: EventCounts };

const STATS_KINDS = ["impression", "click", "close"] as const;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function emptyCounts(): EventCounts {
  return { impression: 0, click: 0, close: 0 };
}

type StatsRow = { popup_id: string; kind: string; n: number };

function applyRows(target: Record<string, PopupStats>, rows: StatsRow[], field: keyof PopupStats): void {
  for (const row of rows) {
    const stats = target[row.popup_id];
    if (stats === undefined) continue; // ⚠ 理論上は起きない(FK で popupIds の外を指せない)が、黙って無視せず読み飛ばすだけに留める
    if (!(STATS_KINDS as readonly string[]).includes(row.kind)) continue;
    stats[field][row.kind as (typeof STATS_KINDS)[number]] = row.n;
  }
}

/**
 * サイト配下の全ポップ(アーカイブ済みを含む)の、表示・クリック・閉じたの数字。
 * 🔴 **単位・期間(設計上の決め)**:
 *   ・数える単位は**ポップごと**(バリアント別・トリガ別の内訳は別の数値ダッシュボードの仕事で、
 *     いまの範囲 = 管理画面のポップ一覧・アーカイブ一覧・完全削除の確認、の範囲外)。
 *   ・クリックは**生の件数**(同じ表示で複数回押されたら複数回数える)。
 *     CTR(ユニーク・impression_id あたり1)に畳む指標は、この3画面には出ない。
 *   ・「直近7日」は**リクエスト時刻からの 7×24 時間のローリング窓(UTC)**。カレンダー日・JST では切らない
 * ——運営者1人の運用で、時差の扱いを決めるだけの実データがまだ無いため最も単純な基準を採った。
 *     ずれが問題になったら、時差の方針を決めてから変える(README にも書く)。
 *   ・「累計」は保持期間の制約なし(90日保持は未実装で、削除も実装していないので
 *     累計 = 今 DB に残っている全件)。
 * 🔴 **取れなかったときは 0 を返さない**: ここは読み取りだけで、`listSites` 等の既存の読み取り関数と
 *   同じ形(try/catch で握り潰さない)。D1 の例外はそのまま投げる。呼び出し側(`app.ts` の `onError`)は、
 *   **バインド自体が無い(`MissingBindingError`)なら 503**(`config`。設定の不備)、**正常なバインドで
 *   クエリ自体が失敗した(それ以外の例外)なら 500**(`upstream`)にする——どちらも画面には「—」を出す側。
 *   **件数0件のポップと、取得そのものが失敗したときを、HTTP の状態コードで分ける**——前者は 200 で
 *   `{ impression: 0, ... }`(グループ化した行が無い = そのキーの件数が0という読み取り)、後者は 500/503。
 *   (tests/admin-stats.test.ts がバインド欠如の経路を・tests/admin-api.test.ts がHTTP層の500/503両方を撃つ)
 * ⚠ **索引**: `events_site_kind_occurred_at`(migration 0003)が無いと、events が増えるほど全表走査になる。
 */
export async function getPopupStats(
  source: DbSource,
  ownerId: string,
  siteId: string,
): Promise<Result<Record<string, PopupStats>>> {
  const db = resolveDb(source);
  const site = await db.prepare(`select 1 from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId).first();
  if (site === null) return notFound();
  const popupRows = await db
    .prepare(`select id from popups where site_id = ?1 and owner_id = ?2`)
    .bind(siteId, ownerId)
    .all<{ id: string }>();
  const popupIds = popupRows.results.map((r) => r.id);
  const out: Record<string, PopupStats> = {};
  for (const id of popupIds) out[id] = { sevenDay: emptyCounts(), lifetime: emptyCounts() };
  if (popupIds.length === 0) return ok(out);
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const [sevenDay, lifetime] = await db.batch([
    db
      .prepare(
        `select popup_id, kind, count(*) as n from events
         where site_id = ?1 and owner_id = ?2 and occurred_at >= ?3
           and kind in ('impression', 'click', 'close')
         group by popup_id, kind`,
      )
      .bind(siteId, ownerId, cutoff),
    db
      .prepare(
        `select popup_id, kind, count(*) as n from events
         where site_id = ?1 and owner_id = ?2
           and kind in ('impression', 'click', 'close')
         group by popup_id, kind`,
      )
      .bind(siteId, ownerId),
  ]);
  applyRows(out, sevenDay.results as StatsRow[], "sevenDay");
  applyRows(out, lifetime.results as StatsRow[], "lifetime");
  return ok(out);
}

/**
 * パターン(バリアント)1件の、累計の表示・クリック・閉じたの数字。
 * 🔴 パターンの完全削除の確認ダイアログが
 *   「数字も一緒に消えます」を出せていなかった(`events` は variant 削除で cascade で消える。
 *   db/migrations/0001_schema.sql の `foreign_key (variant_id, popup_id) ... on delete cascade`)。
 *   `getPopupStats` と同じ考え方(件数0件と取得失敗をHTTPの状態コードで分ける)だが、
 *   対象は popup 単位ではなく variant 単位1件だけなので `sevenDay` は持たない(削除確認には
 *   累計=lifetimeの数字だけが要る)。
 */
export async function getVariantStats(source: DbSource, ownerId: string, variantId: string): Promise<Result<EventCounts>> {
  const db = resolveDb(source);
  const variant = await db.prepare(`select 1 from variants where id = ?1 and owner_id = ?2`).bind(variantId, ownerId).first();
  if (variant === null) return notFound();
  const rows = await db
    .prepare(
      `select kind, count(*) as n from events
       where variant_id = ?1 and owner_id = ?2
         and kind in ('impression', 'click', 'close')
       group by kind`,
    )
    .bind(variantId, ownerId)
    .all<{ kind: string; n: number }>();
  const counts = emptyCounts();
  for (const row of rows.results) {
    if ((STATS_KINDS as readonly string[]).includes(row.kind)) {
      counts[row.kind as (typeof STATS_KINDS)[number]] = row.n;
    }
  }
  return ok(counts);
}

/* ─────────────── 日別の集計(ダッシュボードの推移グラフ) ─────────────── */

export type DailyStatsPoint = { date: string; impression: number; click: number; close: number };
export const DAILY_STATS_PERIODS = [7, 30, 90] as const;
export type DailyStatsPeriod = (typeof DAILY_STATS_PERIODS)[number];

/** `YYYY-MM-DD`(UTC の暦日)。 */
function utcDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `dateOnly`(UTC の暦日)から `delta` 日ずらした `YYYY-MM-DD` を返す。 */
function addUtcDays(dateOnly: string, delta: number): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDateOnly(d);
}

type DailyRow = { day: string; kind: string; n: number };

/**
 * サイト単位(全ポップ合算・アーカイブ済みを含む=既存の `getPopupStats` と同じ単位)の、
 * 表示・クリック・閉じたの**日別**の数字。ダッシュボードの推移グラフ・期間連動タイルのためのAPI。
 *
 * 🔴 **日の区切りは UTC の 0 時**(`occurred_at` は `strftime('...Z','now')` で書かれた UTC の
 *   ISO8601 文字列=db/migrations/0001_schema.sql。`strftime('%Y-%m-%d', occurred_at)` はこれを
 *   そのまま UTC の暦日として切り出せる)。
 * 🔴 **期間は 7/30/90 日(今日を含む・UTCの今日を起点にさかのぼる)。数字が無い日は 0 で埋める**
 *   (件数0の日と、行自体が無い日を区別しない=0件は0件のまま出す。守っているのは
 *   「取得そのものの失敗」と0件の区別であって、日の穴埋めとは別の話)。
 * 🔴 **取れなかったときは 0 を返さない**: `getPopupStats` と同じ形(try/catchで握り潰さない)。
 *   D1 の例外はそのまま投げる(呼び出し側 = `app.ts` の `onError` が 500/503 に写す)。
 * ⚠ **索引**: 既存の `events_site_kind_occurred_at`(site_id, kind, occurred_at。migration 0003)が
 *   `site_id` の絞り込みに効く。このクエリのために新しい索引は足していない。
 */
export async function getDailySiteStats(
  source: DbSource,
  ownerId: string,
  siteId: string,
  period: DailyStatsPeriod,
): Promise<Result<DailyStatsPoint[]>> {
  const db = resolveDb(source);
  const site = await db.prepare(`select 1 from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId).first();
  if (site === null) return notFound();

  // 🔴 `new Date()`(引数無し)はエンジンの時計を直接見るだけで、
  //   `vi.spyOn(Date, "now")` では固定できない(`Date.now()` と`new Date()`は別の経路)。
  //   「いま」の取り方は `getPopupStats` の `cutoff` 計算と同じく、必ず `Date.now()` を経由する
  //   (テストがこの1箇所だけ押さえれば、日付をまたいでも固定した「今日」で検算できる)。
  const today = utcDateOnly(new Date(Date.now()));
  const startDate = addUtcDays(today, -(period - 1));
  const cutoff = `${startDate}T00:00:00.000Z`;

  const byDay = new Map<string, DailyStatsPoint>();
  for (let i = 0; i < period; i++) {
    const date = addUtcDays(startDate, i);
    byDay.set(date, { date, impression: 0, click: 0, close: 0 });
  }

  const rows = await db
    .prepare(
      `select strftime('%Y-%m-%d', occurred_at) as day, kind, count(*) as n from events
       where site_id = ?1 and owner_id = ?2 and occurred_at >= ?3
         and kind in ('impression', 'click', 'close')
       group by day, kind`,
    )
    .bind(siteId, ownerId, cutoff)
    .all<DailyRow>();

  for (const row of rows.results) {
    const point = byDay.get(row.day);
    if (point === undefined) continue; // ⚠ 期間の外(時計のずれ等)の行は読み飛ばすだけに留める
    if (!(STATS_KINDS as readonly string[]).includes(row.kind)) continue;
    point[row.kind as (typeof STATS_KINDS)[number]] = row.n;
  }
  return ok([...byDay.values()]);
}

/**
 * パターンの画像のキーを書く(R2 に置くのは `images.ts` の仕事。ここは DB だけ)。
 * 🔴 **`imageKey` を書く唯一の関数**。キーの形を確かめてから書く。
 * 🔴 **同じ取引(batch)の中で**: ①前のキーを読む ②前のキーを消し直し待ちに積む ③キーを書く
 *   ④新しいキーを消し直し待ちから外す(呼び出し側が置く前に積んでおいたもの)。**③が当たって参照されているときだけ**。
 *   batch が落ちれば全部巻き戻る(参照と積んだ行の片方だけが残らない)。
 */
export async function setVariantImage(
  source: DbSource,
  ownerId: string,
  variantId: string,
  key: string | null,
): Promise<Result<{ previousKey: string | null }>> {
  const db = resolveDb(source);
  if (key !== null && !isImageKey(key)) return invalid("imageKey");
  const previousOf = `select json_extract(content, '$.imageKey') from variants where id = ?1 and owner_id = ?2`;
  /*
    🔴 **画像を「外す」(`key === null`)だけガードを掛ける**(稼働中のポップから最後の配信可能パターンを
    奪わせない)。置く・差し替える(`key` が非 null)は配信できる状態を
    減らさないので、ガード無し(既存のまま)。**同じ条件を、積む文(②)と書く文(③)の両方に掛ける**
    —— ③だけに掛けると、ブロックされた(= content が変わらない)のに②だけが R2 への消し直しを
    予約してしまい、宙に浮いた pending 行が残る(実害は無い=drain 側が「まだ参照されている」で
    実削除を止めるが、綺麗ではない)。
  */
  /*
    🔴 **text 型のガードはすり抜けさせる**(`kind <> 'image'` の分岐を
    忘れると、text 型の `imageKey`(配信判定では使われない、ただの残骸)を外す操作まで、唯一の稼働中
    パターンだからという理由で誤って断ってしまう)。**配信できる状態を減らすのは image 型だけ**なので、
    `kind <> 'image'` を先に見てから `keepsDeliverableGuard` に落とす。
  */
  /*
    ⚠ **`kind` も列名の裸参照ではなく、束縛パラメータで引いたサブクエリにする**(②の `insert ... select`
    には `from variants` が無く、`keepsDeliverableGuard` を直したのと同じ理由で裸の `kind` は
    `no such column: kind` になる)。
  */
  const kindOf = `(select kind from variants where id = ?1 and owner_id = ?2)`;
  const removalGuardClause = key === null ? `and (${kindOf} <> 'image' or ${keepsDeliverableGuard("?1")})` : "";
  const result = await write(() =>
    db.batch([
      db.prepare(`select (${previousOf}) as previous`).bind(variantId, ownerId),
      db
        .prepare(
          `insert into pending_image_deletions (key, owner_id)
           select (${previousOf}), ?2
           where (${previousOf}) is not null and (${previousOf}) is not ?3
             ${removalGuardClause}`,
        )
        .bind(variantId, ownerId, key),
      db
        .prepare(
          `update variants set content = ${key === null ? "json_remove(content, '$.imageKey')" : "json_set(content, '$.imageKey', ?3)"},
             updated_at = ${NOW}
           where id = ?1 and owner_id = ?2
             ${removalGuardClause}`,
        )
        .bind(...(key === null ? [variantId, ownerId] : [variantId, ownerId, key])),
      // 🔴 新しいキーの行を外すのは、**上の UPDATE が当たって、そのキーを実際に参照している行があるとき だけ**
      //   。並行する削除でパターンが消えていたら、行は残り、後の消し直しで R2 から消える。
      db
        .prepare(
          `delete from pending_image_deletions
           where key = ?1 and owner_id = ?2
             and exists (select 1 from variants where id = ?3 and owner_id = ?2 and json_extract(content, '$.imageKey') = ?1)`,
        )
        .bind(key ?? "", ownerId, variantId),
    ]),
  );
  if (!result.ok) return result;
  const [read, , update] = result.value;
  if (update.meta.changes === 0 && key === null) return notFoundOrBlocked(db, ownerId, variantId);
  if (update.meta.changes === 0) return notFound();
  const previous = (read.results as Array<{ previous: unknown }>)[0]?.previous;
  return ok({ previousKey: isImageKey(previous) ? previous : null });
}

/* ═══════════════════════════════════════════════════════════════════════
   PC / スマホ別の表示設定・デザイン。

   🔴 **表示設定(きっかけ・頻度)はポップごとではなく
     サイト単位**になった。0004 の `popup_mobile_display` / `popup_mobile_triggers` を使う関数は
     ここから削除した(API も削除。凍結した表・列の扱い)。サイト単位の表示設定は
     下の「サイト単位の表示設定」節(`site_display_settings` / `site_display_triggers`)にある。
   🔴 **デザイン(パターンの PC / スマホの上書き)はポップごとのまま**(この対象外。後の改訂で画面がつく)。
     `MobileMode` 型はデザインとサイト単位の表示設定の両方が使う(共通の語彙)。

   🔴 **行を足す・消す関数はここに置かない**。行は、ポップ・パターン・サイトを
     作ったときに DB のトリガが揃え、消えるのは親(ポップ・パターン・サイト)の cascade だけ。
     ここにあるのは、既にある行への **UPDATE だけ**。
   🔴 **「個別に設定する(custom)」へ切り替える瞬間だけ PC(desktop)の値を写す**。
     写した後は PC を直してもスマホには効かない。**既に custom なら、もう一度 custom にしても
     PC の値で上書きしない**(二重押しで編集済みのスマホの値を失わせない)。
   ═══════════════════════════════════════════════════════════════════════ */

export type MobileMode = "same_as_pc" | "custom";

export type MobileVariantDesign = {
  variantId: string;
  mode: MobileMode;
  kind: "text" | "image" | null;
  content: Record<string, unknown>;
};

export type MobileVariantDesignInput = {
  kind: "text" | "image";
  content: { headline: string; body: string; buttonLabel: string; imageAlt: string };
};

/* ─────────────── サイト単位の表示設定(きっかけ・頻度) ─────────────── */

export type SiteDeviceDisplay = {
  /** `desktop` の行は常に null(CHECK で強制)。`mobile` の行だけ意味を持つ。 */
  triggersMode: MobileMode | null;
  frequencyMode: MobileMode | null;
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
  triggers: Trigger[];
};

export type SiteDisplay = {
  siteId: string;
  desktop: SiteDeviceDisplay;
  mobile: SiteDeviceDisplay;
};

type SiteDisplaySettingsRow = {
  device: Device;
  triggers_mode: MobileMode | null;
  frequency_mode: MobileMode | null;
  suppress_days: number;
  session_impressions: number;
  post_conversion_days: number;
  min_display_delay_seconds: number;
};

/** サイトの表示設定(PC・スマホ両方の頻度とモード)と、両端末のトリガ(12行)を読む。 */
export async function getSiteDisplay(source: DbSource, ownerId: string, siteId: string): Promise<Result<SiteDisplay>> {
  const db = resolveDb(source);
  const settings = await db
    .prepare(
      `select device, triggers_mode, frequency_mode, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds
       from site_display_settings where site_id = ?1 and owner_id = ?2`,
    )
    .bind(siteId, ownerId)
    .all<SiteDisplaySettingsRow>();
  // 🔴 サイト1つにつき desktop・mobile のちょうど2行(トリガで揃う)。無ければ他人・存在しない
  if (settings.results.length !== 2) return notFound();
  const triggers = await db
    .prepare(
      `select device, kind, enabled, threshold from site_display_triggers where site_id = ?1 and owner_id = ?2 order by device, kind`,
    )
    .bind(siteId, ownerId)
    .all<{ device: Device; kind: TriggerKind; enabled: number; threshold: number | null }>();
  const toTriggers = (device: Device): Trigger[] =>
    triggers.results.filter((t) => t.device === device).map((t) => ({ kind: t.kind, enabled: t.enabled === 1, threshold: t.threshold }));
  const toDevice = (r: SiteDisplaySettingsRow): SiteDeviceDisplay => ({
    triggersMode: r.triggers_mode,
    frequencyMode: r.frequency_mode,
    suppressDays: r.suppress_days,
    sessionImpressions: r.session_impressions,
    postConversionDays: r.post_conversion_days,
    minDisplayDelaySeconds: r.min_display_delay_seconds,
    triggers: toTriggers(r.device),
  });
  const desktop = settings.results.find((r) => r.device === "desktop");
  const mobile = settings.results.find((r) => r.device === "mobile");
  if (desktop === undefined || mobile === undefined) return notFound();
  return ok({ siteId, desktop: toDevice(desktop), mobile: toDevice(mobile) });
}

/**
 * サイトの頻度4項目を書き換える。**desktop は常に受け付ける**。**mobile は `frequency_mode = 'custom'`
 *   のときだけ**(same_as_pc のときの書き込みは API が断る方針)。
 */
export async function updateSiteFrequency(
  source: DbSource,
  ownerId: string,
  siteId: string,
  device: Device,
  input: { suppressDays: number; sessionImpressions: number; postConversionDays: number; minDisplayDelaySeconds: number },
): Promise<Result<null>> {
  const db = resolveDb(source);
  const guard = device === "mobile" ? "and frequency_mode = 'custom'" : "";
  const result = await write(() =>
    db
      .prepare(
        `update site_display_settings set
           suppress_days = ?4, session_impressions = ?5, post_conversion_days = ?6, min_display_delay_seconds = ?7,
           updated_at = ${NOW}
         where site_id = ?1 and owner_id = ?2 and device = ?3 ${guard}`,
      )
      .bind(siteId, ownerId, device, input.suppressDays, input.sessionImpressions, input.postConversionDays, input.minDisplayDelaySeconds)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  if (device === "desktop") return notFound();
  const exists = await db
    .prepare(`select 1 from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'mobile'`)
    .bind(siteId, ownerId)
    .first();
  return exists === null ? notFound() : { ok: false, failure: { kind: "not_custom" } };
}

/** サイトの1つのトリガの ON/OFF を書き換える。desktop は常に受け付け、mobile は `triggers_mode = 'custom'` のときだけ。 */
export async function setSiteTriggerEnabled(
  source: DbSource,
  ownerId: string,
  siteId: string,
  device: Device,
  kind: TriggerKind,
  enabled: boolean,
): Promise<Result<null>> {
  const db = resolveDb(source);
  const guard =
    device === "mobile"
      ? `and exists (select 1 from site_display_settings d where d.site_id = ?1 and d.owner_id = ?2 and d.device = 'mobile' and d.triggers_mode = 'custom')`
      : "";
  const result = await write(() =>
    db
      .prepare(
        `update site_display_triggers set enabled = ?5, updated_at = ${NOW}
         where site_id = ?1 and owner_id = ?2 and device = ?3 and kind = ?4 ${guard}`,
      )
      .bind(siteId, ownerId, device, kind, enabled ? 1 : 0)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  if (device === "desktop") return notFound();
  const exists = await db
    .prepare(`select 1 from site_display_triggers where site_id = ?1 and owner_id = ?2 and device = 'mobile' and kind = ?3`)
    .bind(siteId, ownerId, kind)
    .first();
  return exists === null ? notFound() : { ok: false, failure: { kind: "not_custom" } };
}

/**
 * サイトの1つのトリガの閾値を書き換える。ガードは {@link setSiteTriggerEnabled} と同じ形
 *   (desktop は常に受け付け、mobile は `triggers_mode = 'custom'` のときだけ)。
 * ⚠ **範囲の検査(`threshold` の値そのもの)は呼び出し側(`src/admin/body.ts` の `parseThreshold`)で
 *   済んでいる前提**——ここは「誰の行に書くか」だけを見る(関心を分ける。保存の形は
 *   `setSiteTriggerEnabled` と揃える)。
 */
export async function setSiteTriggerThreshold(
  source: DbSource,
  ownerId: string,
  siteId: string,
  device: Device,
  kind: TriggerKind,
  threshold: number | null,
): Promise<Result<null>> {
  const db = resolveDb(source);
  const guard =
    device === "mobile"
      ? `and exists (select 1 from site_display_settings d where d.site_id = ?1 and d.owner_id = ?2 and d.device = 'mobile' and d.triggers_mode = 'custom')`
      : "";
  const result = await write(() =>
    db
      .prepare(
        `update site_display_triggers set threshold = ?5, updated_at = ${NOW}
         where site_id = ?1 and owner_id = ?2 and device = ?3 and kind = ?4 ${guard}`,
      )
      .bind(siteId, ownerId, device, kind, threshold)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  if (device === "desktop") return notFound();
  const exists = await db
    .prepare(`select 1 from site_display_triggers where site_id = ?1 and owner_id = ?2 and device = 'mobile' and kind = ?3`)
    .bind(siteId, ownerId, kind)
    .first();
  return exists === null ? notFound() : { ok: false, failure: { kind: "not_custom" } };
}

/**
 * きっかけのモードを切り替える(mobile の行だけが持つ)。
 * 🔴 `custom` にする瞬間、**その時点の desktop の6トリガの値を mobile へ写す**。
 *   既に `custom` なら何もしない(2回目の呼び出しで編集済みの値を desktop の値で上書きしない)。
 * ⚠ desktop・mobile は同じ表(`site_display_triggers`)の行なので、裸のテーブル名で相関すると
 *   **内側の FROM に取られてしまう**(シャドーイング。`keepsDeliverableGuard` と同じ理由で
 *   先回りして踏まない)。**`UPDATE ... FROM` に明示のエイリアス**(`m`/`d`)を付けて相関する。
 */
export async function setSiteTriggersMode(source: DbSource, ownerId: string, siteId: string, mode: MobileMode): Promise<Result<null>> {
  const db = resolveDb(source);
  if (mode === "custom") {
    const result = await write(() =>
      db.batch([
        db
          .prepare(
            `update site_display_triggers as m
               set enabled = d.enabled, threshold = d.threshold, updated_at = ${NOW}
             from site_display_triggers as d
             where m.site_id = ?1 and m.owner_id = ?2 and m.device = 'mobile'
               and d.site_id = m.site_id and d.device = 'desktop' and d.kind = m.kind
               and exists (select 1 from site_display_settings s where s.site_id = ?1 and s.owner_id = ?2 and s.device = 'mobile' and s.triggers_mode = 'same_as_pc')`,
          )
          .bind(siteId, ownerId),
        db
          .prepare(
            `update site_display_settings set triggers_mode = 'custom', updated_at = ${NOW}
             where site_id = ?1 and owner_id = ?2 and device = 'mobile' and triggers_mode = 'same_as_pc'`,
          )
          .bind(siteId, ownerId),
      ]),
    );
    if (!result.ok) return result;
    if (changed(result.value[1])) return ok(null);
    const exists = await db
      .prepare(`select 1 from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'mobile'`)
      .bind(siteId, ownerId)
      .first();
    return exists === null ? notFound() : ok(null); // 既に custom = no-op 成功
  }
  const result = await write(() =>
    db
      .prepare(
        `update site_display_settings set triggers_mode = 'same_as_pc', updated_at = ${NOW}
         where site_id = ?1 and owner_id = ?2 and device = 'mobile'`,
      )
      .bind(siteId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

/** 頻度のモードを切り替える(mobile の行だけが持つ)。振る舞いは {@link setSiteTriggersMode} と同じ形。 */
export async function setSiteFrequencyMode(source: DbSource, ownerId: string, siteId: string, mode: MobileMode): Promise<Result<null>> {
  const db = resolveDb(source);
  if (mode === "custom") {
    const result = await write(() =>
      db
        .prepare(
          `update site_display_settings set
             frequency_mode = 'custom',
             suppress_days = (select suppress_days from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'desktop'),
             session_impressions = (select session_impressions from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'desktop'),
             post_conversion_days = (select post_conversion_days from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'desktop'),
             min_display_delay_seconds = (select min_display_delay_seconds from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'desktop'),
             updated_at = ${NOW}
           where site_id = ?1 and owner_id = ?2 and device = 'mobile' and frequency_mode = 'same_as_pc'`,
        )
        .bind(siteId, ownerId)
        .run(),
    );
    if (!result.ok) return result;
    if (changed(result.value)) return ok(null);
    const exists = await db
      .prepare(`select 1 from site_display_settings where site_id = ?1 and owner_id = ?2 and device = 'mobile'`)
      .bind(siteId, ownerId)
      .first();
    return exists === null ? notFound() : ok(null); // 既に custom = no-op 成功
  }
  const result = await write(() =>
    db
      .prepare(
        `update site_display_settings set frequency_mode = 'same_as_pc', updated_at = ${NOW}
         where site_id = ?1 and owner_id = ?2 and device = 'mobile'`,
      )
      .bind(siteId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

/* ─────────────── デザイン(パターンのスマホ用の上書き) ─────────────── */

type MobileVariantDesignRow = { variant_id: string; mode: MobileMode; kind: "text" | "image" | null; content: string };

function toMobileVariantDesign(r: MobileVariantDesignRow): MobileVariantDesign {
  return { variantId: r.variant_id, mode: r.mode, kind: r.kind, content: parseContent(r.content) };
}

export async function getMobileVariantDesign(source: DbSource, ownerId: string, variantId: string): Promise<Result<MobileVariantDesign>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select variant_id, mode, kind, content from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`)
    .bind(variantId, ownerId)
    .first<MobileVariantDesignRow>();
  return row === null ? notFound() : ok(toMobileVariantDesign(row));
}

/**
 * デザインを「PC と同じ」に戻す。🔴 スマホの個別の画像キー(あれば)を、同じ取引で先に
 *   消し直し待ちへ積んでから外す(write-ahead。他の削除処理と同じ約束)。
 * 🔴 外した画像キーを返す(呼び出し側の `images.ts` が、同じ要求の中ですぐ `drain` できるように。
 *   積むだけで終わると、次の画像操作が起きるまで R2 に残り続ける)。
 */
export async function restoreMobileVariantDesign(
  source: DbSource,
  ownerId: string,
  variantId: string,
): Promise<Result<{ previousImageKey: string | null }>> {
  const db = resolveDb(source);
  const previousOf = `select json_extract(content, '$.imageKey') from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`;
  const result = await write(() =>
    db.batch([
      db.prepare(`select (${previousOf}) as previous`).bind(variantId, ownerId),
      db
        .prepare(
          `insert into pending_image_deletions (key, owner_id)
           select (${previousOf}), owner_id from variant_mobile_designs
           where variant_id = ?1 and owner_id = ?2 and json_extract(content, '$.imageKey') is not null`,
        )
        .bind(variantId, ownerId),
      db
        .prepare(
          `update variant_mobile_designs set mode = 'same_as_pc', kind = null, content = '{}', updated_at = ${NOW}
           where variant_id = ?1 and owner_id = ?2`,
        )
        .bind(variantId, ownerId),
    ]),
  );
  if (!result.ok) return result;
  const [read, , update] = result.value;
  if (!changed(update)) return notFound();
  const previous = (read.results as Array<{ previous: unknown }>)[0]?.previous;
  return ok({ previousImageKey: isImageKey(previous) ? previous : null });
}

/**
 * デザインを「個別に設定する(custom)」にする。
 * 🔴 **見た目(kind・headline・body・buttonLabel・imageAlt)は、呼び出し側のスナップショットを信じず、
 *   書き込みと同じ SQL 文で PC(`variants`)の行から直接写す**(以前は呼び出し側
 *   〔`images.ts`〕が組み立てたスナップショットをそのまま書いており、例えば `kind: "text"` を渡せば、
 *   PC が実際には画像型で画像が無くても custom になれてしまった)。
 * 🔴 **画像は `image` 引数で渡す**(複写が要らない=PC が画像型でないときは `null`)。
 *   - `newKey`: `images.ts` が R2 へ複写できた新しいキー。**形を `isImageKey` で検査する**。
 *   - `copiedFromKey`: その複写を始めた時点で `images.ts` が読んだ、**複写元の PC の画像キー**。
 *   🔴🔴 **複写とこの書き込みの間に PC の画像が差し替わるレースを防ぐ**: PC の
 *     行の**今の** `content.imageKey` が `copiedFromKey` と一致するときだけ書く。一致しなければ
 *     (複写を始めてから PC の画像が入れ替わった=複写した内容は「今の PC」のものではない)
 *     `{ kind: "stale_pc_image" }` で断る——**今の PC のテキストと古い画像が混ざった状態を作らない**。
 *     呼び出し側(`images.ts`)は、断られた複写先のキーを消し直し待ちに積んで drain する(再試行は
 *     呼び出し側の判断に委ねる。ここでは自動再試行しない)。
 * 🔴 **切り分け**:
 *   - **データ層(ここ)が守るのは「PC の行の状態」まで**(`kind`・`content.imageKey` の有無・一致)。
 *     書き込みと同じ WHERE 条件で直接 SQL で見る。
 *   - **R2 に実体が実際にあるか(宙に浮いた参照でないか)は D1 からは確認できない**ので、その検査は
 *     呼び出し側(`images.ts`)に残る——`images.ts` が R2 から読めることを確かめたうえで複写し、
 *     複写できた新しいキーと複写元のキーの両方をここへ渡す。
 * 🔴 既に `custom` なら何もしない(二重押しで編集済みの値を上書きしない。{@link setSiteTriggersMode} と同じ判断)。
 */
export async function setMobileVariantDesignCustom(
  source: DbSource,
  ownerId: string,
  variantId: string,
  image: { newKey: string; copiedFromKey: string } | null,
): Promise<Result<MobileVariantDesign>> {
  if (image !== null && !isImageKey(image.newKey)) return invalid("imageKey");
  const db = resolveDb(source);
  const pcKind = `(select kind from variants where id = ?1 and owner_id = ?2)`;
  const pcContent = `(select content from variants where id = ?1 and owner_id = ?2)`;
  const pcCurrentImageKey = `(json_extract(${pcContent}, '$.imageKey'))`;
  const pcTextField = (name: string) => `coalesce(json_extract(${pcContent}, '$.${name}'), '')`;
  const copiedTextFields = `json_object(
    'headline', ${pcTextField("headline")},
    'body', ${pcTextField("body")},
    'buttonLabel', ${pcTextField("buttonLabel")},
    'imageAlt', ${pcTextField("imageAlt")}
  )`;
  const newKey = image?.newKey ?? null;
  const copiedFromKey = image?.copiedFromKey ?? null;
  const result = await write(() =>
    db
      .prepare(
        `update variant_mobile_designs set
           mode = 'custom',
           kind = case when ${pcKind} = 'image' then 'image' else 'text' end,
           content = case when ${pcKind} = 'image' then json_set(${copiedTextFields}, '$.imageKey', ?3) else ${copiedTextFields} end,
           updated_at = ${NOW}
         where variant_id = ?1 and owner_id = ?2 and mode = 'same_as_pc'
           and (
             ${pcKind} <> 'image'
             or (?3 is not null and ${pcKind} = 'image' and ${pcCurrentImageKey} = ?4)
           )`,
      )
      .bind(variantId, ownerId, newKey, copiedFromKey)
      .run(),
  );
  if (!result.ok) return result;
  const readRow = () =>
    db
      .prepare(`select variant_id, mode, kind, content from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`)
      .bind(variantId, ownerId)
      .first<MobileVariantDesignRow>();
  if (changed(result.value)) {
    const row = await readRow();
    return row === null ? notFound() : ok(toMobileVariantDesign(row));
  }
  // 0件: 他人・存在しない / 既に custom(no-op 成功)/ PC が画像型なのに画像が無い or 入れ替わった、のどれか
  const existing = await db.prepare(`select mode from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`).bind(variantId, ownerId).first<{
    mode: MobileMode;
  }>();
  if (existing === null) return notFound();
  if (existing.mode === "custom") {
    const row = await readRow();
    return row === null ? notFound() : ok(toMobileVariantDesign(row)); // 既に custom でも、現状をそのまま返す(no-op 成功)
  }
  // mode は same_as_pc なのに WHERE が落ちた。`image === null` なら「PC が画像型なのに何も渡されなかった」
  // (未アップロード)。`image !== null` なら「渡された複写元が PC の今のキーと一致しない」(レース)。
  return image === null ? invalid("imageKey") : { ok: false, failure: { kind: "stale_pc_image" } };
}

/**
 * デザインの見た目(型・見出し・本文・ボタン文言・画像の説明)を保存する。
 * 🔴 **`custom` のときだけ受け付ける**。🔴 **画像型は、既にスマホの個別の画像キーが入っているときだけ
 *   保存できる**(「配れる状態でしか保存できない」という方針)——画像のアップロードは
 *   別の API(`setMobileVariantImage`)が先に行う。画像のキー自体はここでは書き換えない(元の値を残す)。
 */
export async function updateMobileVariantDesign(
  source: DbSource,
  ownerId: string,
  variantId: string,
  input: MobileVariantDesignInput,
): Promise<Result<null>> {
  const db = resolveDb(source);
  if (requiresImageAlt(input)) return invalid("imageAlt");
  const result = await write(() =>
    db
      .prepare(
        `update variant_mobile_designs set
           kind = ?1,
           content = case when json_extract(content, '$.imageKey') is null then ?2
                          else json_set(?2, '$.imageKey', json_extract(content, '$.imageKey')) end,
           updated_at = ${NOW}
         where variant_id = ?3 and owner_id = ?4 and mode = 'custom'
           and (?1 <> 'image' or json_extract(content, '$.imageKey') is not null)`,
      )
      .bind(input.kind, textContent(input), variantId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  if (changed(result.value)) return ok(null);
  const row = await db
    .prepare(`select mode, json_extract(content, '$.imageKey') as image_key from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`)
    .bind(variantId, ownerId)
    .first<{ mode: MobileMode; image_key: string | null }>();
  if (row === null) return notFound();
  if (row.mode !== "custom") return { ok: false, failure: { kind: "not_custom" } };
  return invalid("imageKey"); // custom だが、画像型なのに画像キーがまだ無い
}

/**
 * スマホの個別の画像キーを書く(R2 に置くのは `images.ts` の仕事。ここは DB だけ)。
 * 🔴 PC の `setVariantImage` の相当品。`custom` のときだけ受け付ける。
 *   write-ahead の形(①前のキーを読む ②前のキーを積む ③キーを書く ④新しいキーを外す)も同じ。
 * ⚠ **画像のアップロード・削除では、`imageKey` を書くのはここだけ**(`images.ts` の
 *   `setMobileVariantImage`/`removeMobileVariantImage` から呼ばれる)。⚠ ただし
 *   「個別に設定する(custom)」に切り替える瞬間の複写は、別の経路(`setMobileVariantDesignCustom`)が
 *   PC の画像キーの複写先を `content` ごと書く——**`imageKey` を書く経路はこの2つ**(PC の
 *   `setVariantImage` は1つだけなので、ここは PC とは形が違う)。
 */
export async function setMobileVariantImageKey(
  source: DbSource,
  ownerId: string,
  variantId: string,
  key: string | null,
): Promise<Result<{ previousKey: string | null }>> {
  const db = resolveDb(source);
  if (key !== null && !isImageKey(key)) return invalid("imageKey");
  const previousOf = `select json_extract(content, '$.imageKey') from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`;
  /*
    🔴 画像型のまま、画像キーだけを外すことはできない。差し替えはアップロード
    (`key` が非 null の呼び出し)で行い、「外す」(`key === null`)は kind が image でなくなっている
    ときだけ通す。**同じ条件を、積む文(②)と書く文(③)の両方に掛ける**(片方だけだと、
    断られた操作でも画像キーだけが `pending_image_deletions` に積まれる=`enqueueImagesUnder` で
    踏んだ型と同じ)。
    ⚠ **`kind`/`mode` は裸の列参照ではなく、束縛パラメータで引いたサブクエリにする**(`setVariantImage` の
    `kindOf` と同じ理由)。②の `insert ... select` には `from variant_mobile_designs` が無いので、
    裸の `kind`/`mode` は `no such column` になる(実測)。
    🔴 **積む文(②)にも `mode = 'custom'` を掛ける**。以前は書く文(③)だけに
    `mode = 'custom'` があり、`same_as_pc` のまま呼んだ(= 断られるはずの)呼び出しでも、積む文は
    無条件に実行されてしまっていた——断られた操作が `pending_image_deletions` を変えてしまう、
    `enqueueImagesUnder` で踏んだ型と同じ。
  */
  const kindOf = `(select kind from variant_mobile_designs where variant_id = ?1 and owner_id = ?2)`;
  const modeOf = `(select mode from variant_mobile_designs where variant_id = ?1 and owner_id = ?2)`;
  const removalGuard = key === null ? `and ${kindOf} <> 'image'` : "";
  const customGuard = `and ${modeOf} = 'custom'`;
  const result = await write(() =>
    db.batch([
      db.prepare(`select (${previousOf}) as previous`).bind(variantId, ownerId),
      db
        .prepare(
          `insert into pending_image_deletions (key, owner_id)
           select (${previousOf}), ?2
           where (${previousOf}) is not null and (${previousOf}) is not ?3
             ${customGuard}
             ${removalGuard}`,
        )
        .bind(variantId, ownerId, key),
      db
        .prepare(
          `update variant_mobile_designs set
             content = ${key === null ? "json_remove(content, '$.imageKey')" : "json_set(content, '$.imageKey', ?3)"},
             updated_at = ${NOW}
           where variant_id = ?1 and owner_id = ?2 and mode = 'custom'
             ${removalGuard}`,
        )
        .bind(...(key === null ? [variantId, ownerId] : [variantId, ownerId, key])),
      db
        .prepare(
          `delete from pending_image_deletions
           where key = ?1 and owner_id = ?2
             and exists (select 1 from variant_mobile_designs where variant_id = ?3 and owner_id = ?2 and json_extract(content, '$.imageKey') = ?1)`,
        )
        .bind(key ?? "", ownerId, variantId),
    ]),
  );
  if (!result.ok) return result;
  const [read, , update] = result.value;
  if (update.meta.changes === 0) {
    const row = await db
      .prepare(`select mode, kind from variant_mobile_designs where variant_id = ?1 and owner_id = ?2`)
      .bind(variantId, ownerId)
      .first<{ mode: MobileMode; kind: "text" | "image" | null }>();
    if (row === null) return notFound();
    if (row.mode !== "custom") return { ok: false, failure: { kind: "not_custom" } };
    if (key === null && row.kind === "image") return invalid("kind"); // 画像型のまま外せない(差し替えはアップロードで)
    return notFound(); // ここには来ない想定(上の分岐で理由をすべて説明できる)
  }
  const previous = (read.results as Array<{ previous: unknown }>)[0]?.previous;
  return ok({ previousKey: isImageKey(previous) ? previous : null });
}
