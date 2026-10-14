/*
  画像(R2)のデータ層。**R2 に触るのはここだけ**(`tests/d1-access-boundary.test.ts` が R2 の型も見る)。

  🔴 置き場のキーは `images/<16 バイトの乱数の16進>.<拡張子>`(内部 id・所有者を URL に出さない)。
  🔴 **「置けた」を成功にしない**: 置いた後 `head` で大きさを確かめる。
  🔴 **消す予定のキーは、先に積む(write-ahead)**: `pending_image_deletions` への INSERT を、
    参照を外す・行を消す DB の操作と**同じ取引**に入れる(`admin.ts`)。新しいキーは**置く前に**積む。
    → DB の取引が落ちれば参照と積んだ行が一緒に巻き戻り、R2 の削除が途中で止まっても積んだ行が残る。
    積んだ行は、R2 から消せたら外す。同じ所有者の次の画像の操作で消し直す(積んでから 10 分以上のもの)。
    積んでいる数は応答で返す(`cleanupPending`)。⚠ 消し直すまでの間は、キーを知っていれば配信の /img から取れる。
  ⚠ **限界**: 新しいキーを積む INSERT そのものが失敗したら、置かずに例外を投げる。
    積んだ後で Worker が止まった場合は、置いた画像は次の消し直しまで残る(行は残っているので、いずれ消える)。
  🔴 **所有者の分離**: 画像を書く・消す前に、そのパターン(またはサイト・ポップ)が呼び出し側の所有者のものかを
    データ層の関数(`admin.ts`)で確かめる。積んだキーも所有者の条件つきで扱う。
  ⚠ R2 のバインドは「読むだけ」に絞れない(wrangler の設定項目に無い)。配信の Worker は読むだけの
    `image-read.ts` を使い、**このファイル(書き込み)を import しない**(tests/delivery-imports.test.ts)。
*/
import * as admin from "./admin";
import { isImageKey } from "./shapes";
import { resolveDb, resolveImages, type Bindings } from "./source";

export type ImageResult<T> = admin.Result<T>;

/** 1回の操作で消し直す積んだキーの上限(1回の要求の仕事を有限にする)。 */
export const RETRY_BATCH = 20;
/**
 * 積んでからこれだけ経ったキーだけを、ほかの操作が消し直す。
 * ⚠ 置いている途中のアップロード(先に積んである新しいキー)を、並行する別の要求が消さないため。
 */
export const RETRY_MIN_AGE_MS = 10 * 60 * 1000;

function newImageKey(ext: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `images/${hex}.${ext}`;
}

/**
 * 積んだキーを R2 から消し、消せたら積んだ行を外す。
 * 🔴 **まだどこかのパターンが参照しているキーは R2 から消さない**(行だけ外す)。
 *   例: DB の記録は通ったのに応答が届かず、こちらが「失敗」と思った場合。
 * ⚠ 1つのキーで失敗しても、残りは続ける。失敗したキーの行は残る(次に消し直す)。
 */
async function drain(env: Bindings, ownerId: string, keys: string[]): Promise<void> {
  const db = resolveDb(env);
  for (const key of keys.filter(isImageKey)) {
    try {
      // 🔴 PC(`variants`)だけでなく、スマホの個別デザイン(`variant_mobile_designs`)の
      //   参照も見る。片方しか見ないと、まだ使われているキーを消してしまう。
      const referenced = await db
        .prepare(
          `select 1 as x from variants where json_extract(content, '$.imageKey') = ?1
           union
           select 1 as x from variant_mobile_designs where json_extract(content, '$.imageKey') = ?1
           limit 1`,
        )
        .bind(key)
        .first();
      if (referenced === null) await resolveImages(env).delete(key);
      await db.prepare(`delete from pending_image_deletions where key = ?1 and owner_id = ?2`).bind(key, ownerId).run();
    } catch {
      await db
        .prepare(`update pending_image_deletions set attempts = attempts + 1 where key = ?1 and owner_id = ?2`)
        .bind(key, ownerId)
        .run()
        .catch(() => {});
    }
  }
}

async function pendingCount(env: Bindings, ownerId: string): Promise<number> {
  const row = await resolveDb(env)
    .prepare(`select count(*) as c from pending_image_deletions where owner_id = ?1`)
    .bind(ownerId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * 積んだキーを消し直す(所有者の分だけ・積んでから {@link RETRY_MIN_AGE_MS} 以上経ったもの・1回に {@link RETRY_BATCH} 件まで)。
 * 画像の操作の最初に呼ぶ。⚠ ここでの失敗は、その操作を止めない(積んだ行は残り、次の操作でまた試す)。
 */
export async function retryPendingImageDeletions(
  env: Bindings,
  ownerId: string,
  now: Date = new Date(),
): Promise<ImageResult<{ remaining: number }>> {
  const rows = await resolveDb(env)
    .prepare(
      `select key from pending_image_deletions where owner_id = ?1 and created_at <= ?2
       order by created_at, key limit ?3`,
    )
    .bind(ownerId, new Date(now.getTime() - RETRY_MIN_AGE_MS).toISOString(), RETRY_BATCH)
    .all<{ key: string }>();
  await drain(env, ownerId, rows.results.map((r) => r.key));
  return { ok: true, value: { remaining: await pendingCount(env, ownerId) } };
}

async function retryQuietly(env: Bindings, ownerId: string): Promise<void> {
  try {
    await retryPendingImageDeletions(env, ownerId);
  } catch {
    /* 積んだ行は残る。次の操作でまた試す */
  }
}

export type ImageOutcome = {
  /** この所有者の、R2 から消せずに積んでいるキーの数(0 でなければ、消し直しを待っている画像がある) */
  cleanupPending: number;
};

export type StoredImage = ImageOutcome & { key: string };

/**
 * パターンに画像を付ける(前の画像は R2 から消す。消せなければ積んだまま)。
 * 🔴 **置く前に、新しいキーを消し直し待ちに積む**(write-ahead)。DB への記録(`setVariantImage`)が同じ取引で
 *   その行を外す。記録まで届かなかった(例外・失敗の値・Worker が途中で止まった)場合、行が残り、
 *   その場で消すか、後で消し直される。
 * ⚠ 積む INSERT が失敗したら、置かずに例外を投げる(握り潰さない)。
 * @param image 形式・大きさ・寸法の検査を**済ませた**バイト列(`src/lib/storage/image.ts`)
 */
export async function storeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
  image: { bytes: Uint8Array; contentType: string; ext: string },
): Promise<ImageResult<StoredImage>> {
  const owned = await admin.getVariant(env, ownerId, variantId);
  if (!owned.ok) return owned;
  await retryQuietly(env, ownerId);
  const bucket = resolveImages(env);
  const key = newImageKey(image.ext);
  await resolveDb(env)
    .prepare(`insert into pending_image_deletions (key, owner_id) values (?1, ?2)`)
    .bind(key, ownerId)
    .run();
  let written: Awaited<ReturnType<typeof admin.setVariantImage>>;
  try {
    await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
    const head = await bucket.head(key);
    if (head === null || head.size !== image.bytes.byteLength) throw new Error("image verification failed after put");
    written = await admin.setVariantImage(env, ownerId, variantId, key);
  } catch (error) {
    // 🔴 新しいキーを消しにいく(消せなければ、積んだ行が残る)。元の例外はそのまま投げる
    await drain(env, ownerId, [key]).catch(() => {});
    throw error;
  }
  if (!written.ok) {
    await drain(env, ownerId, [key]);
    return written;
  }
  if (written.value.previousKey !== null && written.value.previousKey !== key) {
    await drain(env, ownerId, [written.value.previousKey]);
  }
  return { ok: true, value: { key, cleanupPending: await pendingCount(env, ownerId) } };
}

/** 画像を外す(DB のキーを外すのと同じ取引で前のキーを積み、R2 から消す)。 */
export async function removeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<ImageOutcome>> {
  const written = await admin.setVariantImage(env, ownerId, variantId, null);
  if (!written.ok) return written;
  await retryQuietly(env, ownerId);
  if (written.value.previousKey !== null) await drain(env, ownerId, [written.value.previousKey]);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}

/*
  ─────────────── 削除(配下の画像も消す) ───────────────
  🔴 行を消すのと**同じ取引で**、配下の(アーカイブ済みを含む)全パターンの画像のキーを積む(`admin.ts` の deleteX)。
    その後 R2 から消し、消せたら積んだ行を外す。
*/
async function afterDelete(
  env: Bindings,
  ownerId: string,
  deleted: admin.Result<admin.Deleted>,
): Promise<ImageResult<ImageOutcome>> {
  if (!deleted.ok) return deleted;
  await retryQuietly(env, ownerId);
  await drain(env, ownerId, deleted.value.queuedImageKeys);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}

export async function deleteSiteWithImages(env: Bindings, ownerId: string, siteId: string): Promise<ImageResult<ImageOutcome>> {
  return afterDelete(env, ownerId, await admin.deleteSite(env, ownerId, siteId));
}

export async function deletePopupWithImages(
  env: Bindings,
  ownerId: string,
  popupId: string,
): Promise<ImageResult<ImageOutcome>> {
  return afterDelete(env, ownerId, await admin.deletePopup(env, ownerId, popupId));
}

export async function deleteVariantWithImages(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<ImageOutcome>> {
  return afterDelete(env, ownerId, await admin.deleteVariant(env, ownerId, variantId));
}

/*
  ─────────────── スマホのデザイン ───────────────
  🔴 **1つのキーを参照するのは1か所**を保つ。スマホを個別にしたとき PC の画像を使う場合は、
    同じキーを PC とスマホで共有せず、**R2 上で別のキーに複写**する。複写の手順は `storeVariantImage` と
    同じ write-ahead(新しいキーを置く前に積む → DB が書けたら外す)。
*/

/**
 * デザインを「PC と同じ」に戻す。外れた個別の画像キーがあれば、**この要求の中ですぐ** R2 から消そうとする
 * (`admin.restoreMobileVariantDesign` 自体は積むだけ=write-ahead。
 *  積むだけで終わると、次に別の画像操作が起きるまで R2 に残り続ける——ほかの画像を伴う操作
 *  〔`setMobileVariantImage`・`removeMobileVariantImage`・削除系〕と同じ形に揃える)。
 * 🔴 **`drain` が失敗しても 200 で隠さない**: `drain` 自体は1つのキーの失敗を
 *   握り潰す(次の消し直しに委ねる設計)ので、ここでは他の画像操作と同じく `cleanupPending`
 *   (この所有者がまだ R2 から消せずに積んでいる数)を応答で返す——呼び出し側(ルート)は
 *   `withCleanup` を通し、0 でなければログにも出す。
 */
export async function restoreMobileVariantDesignWithImages(env: Bindings, ownerId: string, variantId: string): Promise<ImageResult<ImageOutcome>> {
  await retryQuietly(env, ownerId);
  const restored = await admin.restoreMobileVariantDesign(env, ownerId, variantId);
  if (!restored.ok) return restored;
  if (restored.value.previousImageKey !== null) await drain(env, ownerId, [restored.value.previousImageKey]);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}

/** `enterCustomMobileDesign` の成功の値。デザインそのものに加え、R2 から消せずに積んでいる数も返す。 */
export type MobileDesignResult = admin.MobileVariantDesign & ImageOutcome;

/**
 * デザインを「個別に設定する(custom)」にする。PC がいま画像型で画像を持っていれば、
 * **その画像を新しいキーへ複写してから**スマホの行に書く(PC の画像と同じキーを共有しない)。
 * 🔴 既に `custom` なら何もしない(現状をそのまま返す。`admin.setMobileVariantDesignCustom` の no-op と同じ判断)。
 * 🔴 **片付け(消し直し待ち)の失敗を隠さない**: 他の画像操作と同じく、応答に
 *   `cleanupPending`(この所有者がまだ R2 から消せずに積んでいる数)を含める——ルートは `withCleanup` を通す。
 */
export async function enterCustomMobileDesign(env: Bindings, ownerId: string, variantId: string): Promise<ImageResult<MobileDesignResult>> {
  const current = await admin.getMobileVariantDesign(env, ownerId, variantId);
  if (!current.ok) return current;
  if (current.value.mode === "custom") return { ok: true, value: { ...current.value, cleanupPending: await pendingCount(env, ownerId) } }; // 二重押しで PC の値を上書きしない

  const pc = await admin.getVariant(env, ownerId, variantId);
  if (!pc.ok) return pc;
  await retryQuietly(env, ownerId);

  const pcImageKey = pc.value.content.imageKey;
  let image: { newKey: string; copiedFromKey: string } | null = null;

  if (pc.value.kind === "image") {
    /*
      🔴 「配れるかどうかは PC 側だけで決まる」不変条件(`DELIVERABLE_VARIANT`)を、スマホへの複写でも
      崩さない。PC が画像型なのに画像キーが無い(未アップロード)、あるいは
      R2 に実体が無い(宙に浮いた参照)なら、**「個別に設定する」への切り替えそのものを拒否する**——
      以前は「画像無しの image 型」のまま黙って進んでいたが、それは PC 側の非配信状態をスマホへ
      そのまま持ち込むことになり、不変条件が崩れる。
    */
    if (!isImageKey(pcImageKey)) return { ok: false, failure: { kind: "invalid", field: "imageKey" } };
    const bucket = resolveImages(env);
    const source = await bucket.get(pcImageKey);
    if (source === null) return { ok: false, failure: { kind: "invalid", field: "imageKey" } };
    const bytes = new Uint8Array(await source.arrayBuffer());
    const ext = pcImageKey.split(".").pop() ?? "png";
    const newKey = newImageKey(ext);
    await resolveDb(env).prepare(`insert into pending_image_deletions (key, owner_id) values (?1, ?2)`).bind(newKey, ownerId).run();
    try {
      await bucket.put(newKey, bytes, { httpMetadata: { contentType: source.httpMetadata?.contentType ?? "application/octet-stream" } });
      const head = await bucket.head(newKey);
      if (head === null || head.size !== bytes.byteLength) throw new Error("mobile image copy verification failed");
    } catch (error) {
      await drain(env, ownerId, [newKey]).catch(() => {});
      throw error;
    }
    // 🔴 複写元のキー(`pcImageKey`)も一緒に渡す——`admin.setMobileVariantDesignCustom` が、書き込みの
    //   その瞬間の PC の画像キーと一致するかを見る(複写とこの後の書き込みの間に PC の画像が
    //   差し替わるレースを防ぐ)。
    image = { newKey, copiedFromKey: pcImageKey };
  }

  /*
    🔴 **見出し・本文・ボタン文言・画像の説明・kind は、ここでは組み立てない**。
    `admin.setMobileVariantDesignCustom` が書き込みと同じ SQL 文で PC(`variants`)の行から直接写す
    ——ここ(`images.ts`)から渡すのは、R2 に複写できた新しい画像キーと複写元のキーだけ
    (複写が要らなければ `null`)。PC の見た目を呼び出し側のスナップショットとして信じさせない。
  */
  const written = await admin.setMobileVariantDesignCustom(env, ownerId, variantId, image);
  // 🔴 新しいキーの pending 行を外すのは `drain` に任せる(「まだ参照されているか」を見てから R2 を消すかどうかを決める、
  //   `setVariantImage` と同じ安全策)。書き込みに失敗していれば(PC の画像が差し替わった場合を含む)、
  //   ここで newKey は宙に浮くので drain で消す。
  if (image !== null) await drain(env, ownerId, [image.newKey]);
  if (!written.ok) return written;
  return { ok: true, value: { ...written.value, cleanupPending: await pendingCount(env, ownerId) } };
}

/** スマホの個別の画像を置く(前の画像は R2 から消す。消せなければ積んだまま)。`custom` のときだけ受け付ける。 */
export async function setMobileVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
  image: { bytes: Uint8Array; contentType: string; ext: string },
): Promise<ImageResult<StoredImage>> {
  const owned = await admin.getMobileVariantDesign(env, ownerId, variantId);
  if (!owned.ok) return owned;
  await retryQuietly(env, ownerId);
  const bucket = resolveImages(env);
  const key = newImageKey(image.ext);
  await resolveDb(env).prepare(`insert into pending_image_deletions (key, owner_id) values (?1, ?2)`).bind(key, ownerId).run();
  let written: Awaited<ReturnType<typeof admin.setMobileVariantImageKey>>;
  try {
    await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
    const head = await bucket.head(key);
    if (head === null || head.size !== image.bytes.byteLength) throw new Error("mobile image verification failed after put");
    written = await admin.setMobileVariantImageKey(env, ownerId, variantId, key);
  } catch (error) {
    await drain(env, ownerId, [key]).catch(() => {});
    throw error;
  }
  if (!written.ok) {
    await drain(env, ownerId, [key]);
    return written;
  }
  if (written.value.previousKey !== null && written.value.previousKey !== key) {
    await drain(env, ownerId, [written.value.previousKey]);
  }
  return { ok: true, value: { key, cleanupPending: await pendingCount(env, ownerId) } };
}

/** スマホの個別の画像を外す。`custom` のときだけ受け付ける。 */
export async function removeMobileVariantImage(env: Bindings, ownerId: string, variantId: string): Promise<ImageResult<ImageOutcome>> {
  const written = await admin.setMobileVariantImageKey(env, ownerId, variantId, null);
  if (!written.ok) return written;
  await retryQuietly(env, ownerId);
  if (written.value.previousKey !== null) await drain(env, ownerId, [written.value.previousKey]);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}
