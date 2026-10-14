/*
  管理画面の API(`/api/admin/*`)を呼ぶだけの薄いクライアント。
  ⚠ 認可・検査はサーバー側(src/admin/app.ts・src/admin/body.ts)が正。ここは呼び出しの形を揃えるだけ。
  🔴 変更系は Content-Type を明示する(サーバー側の CSRF 検査 ②③が見ているのと同じ値)。

  🔴 認証確認は `(app)/layout.tsx` の初回
  (`useRequireSession`)だけで行われ、以後に各ページが呼ぶ `getJson`/`postJson` 等の 401 は
  普通のエラーとして扱われていた(`variantActionError.ts` が文言に変えるだけで、画面には
  認証済みのUI・操作がそのまま残る)。開いたまま別タブでログアウトする・サーバー側で
  セッションが切れる等が起きた後にソフト遷移(`GuardedLink.tsx`)で画面を移っても `/login` へ
  送られない——`(app)/layout.tsx` はルート遷移のたびに再マウントされないため、初回の確認
  (`useRequireSession`)はもう一度走らない。
  **ここで一律に401を見る**: `/login` 以外への呼び出しが401を受けたら、WORKSPACE名のタブ内
  キャッシュを消し、`/login` へ**フルリロードで**送る(ソフト遷移にしない——認証が切れた
  クライアント側の状態を次の画面に持ち越さないため)。`/login` 自身への呼び出し(パスワード
  違い等)は対象外(ログイン画面が入力欄のエラーとしてそのまま表示する)。

  🔴 `uploadVariantImage`(画像アップロード)は
  進捗イベントのために `fetch`(`request()`)ではなく `XMLHttpRequest` を直接使っており、
  上記の401対応はそちらを素通りしていた。判定を `redirectToLoginIfUnauthorized` に1つへ
  まとめ、`request()`・`uploadVariantImage` の両方から呼ぶ(呼び出し元ごとに書き写さない)。
*/
import { clearAllPopupEditSnapshots } from "./popupEditSession";
import { armGlobalBeforeUnloadBypass } from "./unsavedChanges";
import { clearCachedWorkspaceName } from "./workspaceCache";

export type ApiError = { ok: false; status: number; reason: string; field?: string; message?: string };
export type ApiOk<T> = { ok: true; data: T };
export type ApiResult<T> = ApiOk<T> | ApiError;

/** `/login` 以外への呼び出しが401なら、WORKSPACE名キャッシュを消し `/login` へフルリロードで送る。 */
function redirectToLoginIfUnauthorized(status: number, path: string): void {
  if (status === 401 && path !== "/login") {
    clearCachedWorkspaceName();
    clearAllPopupEditSnapshots();
    armGlobalBeforeUnloadBypass();
    window.location.href = "/login";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, { ...init, credentials: "same-origin" });
  } catch {
    // ⚠ ネットワーク自体が失敗(オフライン・CORS 等)。status 0 = 通信できなかったことの印
    return { ok: false, status: 0, reason: "network" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    redirectToLoginIfUnauthorized(res.status, path);
    return {
      ok: false,
      status: res.status,
      reason: typeof record.reason === "string" ? record.reason : "unknown",
      field: typeof record.field === "string" ? record.field : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return { ok: true, data: record.data as T };
}

export function getJson<T>(path: string): Promise<ApiResult<T>> {
  return request<T>(path, { method: "GET" });
}

export function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * 🔴 display/page.tsx の1本の直列キューが送るPUTは、
 *   `pagehide`(タブを閉じる・外部へ移る)の最中に送信中のまま中断されうる(`keepalive`が
 *   無い普通の`fetch`は、ページが実際に破棄される瞬間に打ち切られることがある)。
 *   `options.keepalive`を渡せるようにし、キューの送信元はすべてこれを`true`にする
 *   (呼び出し側を変えない既存の呼び出しは、省略時`false`相当=今までと同じ)。
 */
export function putJson<T>(path: string, body: unknown, options?: { keepalive?: boolean }): Promise<ApiResult<T>> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: options?.keepalive,
  });
}

export function deleteJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * ページを離れる瞬間(アンマウント・`visibilitychange`=hidden・`pagehide`)に、待ち中の自動保存を
 * 取りこぼさず送るための fire-and-forget な PUT。`keepalive: true` はページが実際に破棄された後も
 * ブラウザがリクエストの送信を続ける(普通の `fetch` はこの時点で中断されうる)。応答は見ない
 * (見ても画面はもう無い)・401のログイン送りもしない(離脱中にログイン画面へ割り込む意味が無い)。
 */
export function putJsonKeepalive(path: string, body: unknown): void {
  void fetch(`/api/admin${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {
    // 画面はもう離脱している。失敗しても拾う先が無い。
  });
}

export type UploadResult = { ok: true } | { ok: false; status: number; reason: string; message?: string };

/**
 * 画像のアップロード(src/admin/app.ts の PUT /variants/:id/image)。
 * 🔴 本文は画像のバイト列そのもの・Content-Type は `application/octet-stream` 固定(サーバー側のCSRF検査と一致させる)。
 * ⚠ `fetch` は読み込みの進捗イベントを持たないため、進捗バーのために `XMLHttpRequest` を使う。
 */
export function uploadVariantImage(variantId: string, file: File | Blob, onProgress: (percent: number) => void): Promise<UploadResult> {
  const path = `/variants/${variantId}/image`;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/admin${path}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        redirectToLoginIfUnauthorized(xhr.status, path);
        resolve({
          ok: false,
          status: xhr.status,
          reason: typeof body?.reason === "string" ? body.reason : "unknown",
          message: typeof body?.message === "string" ? body.message : undefined,
        });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, reason: "network" });
    xhr.send(file);
  });
}
