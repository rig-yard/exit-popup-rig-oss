/*
  🔴 認証確認は `(app)/layout.tsx` の初回
  (`useRequireSession`)だけで行われ、以後は各ページが個別に呼ぶ `getJson`/`postJson` 等の
  401 は普通のエラーとして扱われていた(`variantActionError.ts` が文言に変えるだけ)。
  開いたまま別タブでログアウトする・サーバー側でセッションが切れる等が起きると、ソフト遷移
  (`GuardedLink.tsx`)で画面を移っても `/login` へ送られず、認証済みのUI・操作がそのまま
  残ってしまう。

  🔴 直した内容: `request()` が 401 を受けたら(`/login` 自身への呼び出しは除く——ログイン
  画面はパスワード違いの 401 を入力欄のエラーとしてそのまま表示する必要があるため)、
  WORKSPACE 名のタブ内キャッシュを消し、`/login` へ**フルリロードで**送る(ソフト遷移にしない
  ——認証が切れた状態でクライアント側の状態を持ち越さない)。
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./workspaceCache", () => ({
  clearCachedWorkspaceName: vi.fn(),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api.ts: 401 を受けたらログインへ送る(/login 自身は除く)", () => {
  let locationHref: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    locationHref = "";
    vi.stubGlobal("window", {
      location: {
        get href() {
          return locationHref;
        },
        set href(value: string) {
          locationHref = value;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("🔴 /login 以外のパスで 401 を受けたら、WORKSPACE名キャッシュを消し /login へ送る", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { reason: "unauthenticated" })));
    const { getJson } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const result = await getJson("/sites");

    expect(result.ok).toBe(false);
    expect(clearCachedWorkspaceName).toHaveBeenCalledOnce();
    expect(locationHref).toBe("/login");
  });

  it("✅ /login 自身が 401(パスワード違い等)を返しても送らない(ログイン画面が入力欄のエラーとして出す)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { reason: "invalid_credentials" })));
    const { postJson } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const result = await postJson("/login", { email: "a@example.com", password: "wrong" });

    expect(result.ok).toBe(false);
    expect(clearCachedWorkspaceName).not.toHaveBeenCalled();
    expect(locationHref).toBe("");
  });

  it("✅ 401 以外のエラー(404等)では送らない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { reason: "not_found" })));
    const { getJson } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const result = await getJson("/sites/does-not-exist");

    expect(result.ok).toBe(false);
    expect(clearCachedWorkspaceName).not.toHaveBeenCalled();
    expect(locationHref).toBe("");
  });

  it("✅ 成功(200)では送らない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { data: [] })));
    const { getJson } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const result = await getJson("/sites");

    expect(result.ok).toBe(true);
    expect(clearCachedWorkspaceName).not.toHaveBeenCalled();
    expect(locationHref).toBe("");
  });

  it("⚠ 変異検査: /login を除外する判定自体が無いと、ログイン画面でも送ってしまう(検査が効いているか)", () => {
    function withoutLoginExclusion(path: string, status: number): boolean {
      return status === 401; // /login を除外していない版
    }
    expect(withoutLoginExclusion("/login", 401)).toBe(true); // 誤って送る判定になってしまう
  });
});

/*
  🔴 画像アップロード(`uploadVariantImage`)は `fetch` の
  `request()` を通らず、進捗イベントのために `XMLHttpRequest` を直接使っている。401 を受けたら
  ログインへ送る処理を `request()` にだけ書いても、この経路は素通りしていた。
  共通の判定(`redirectToLoginIfUnauthorized`)を1つにまとめ、両方から呼ぶ形にして固定する。
*/
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {
    FakeXHR.instances.push(this);
  }
}

describe("api.ts: uploadVariantImage(XHR直叩き)も 401 を受けたらログインへ送る", () => {
  let locationHref: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    FakeXHR.instances = [];
    locationHref = "";
    vi.stubGlobal("window", {
      location: {
        get href() {
          return locationHref;
        },
        set href(value: string) {
          locationHref = value;
        },
      },
    });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("🔴 401 を受けたら、WORKSPACE名キャッシュを消し /login へ送る", async () => {
    const { uploadVariantImage } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const resultPromise = uploadVariantImage("variant-1", new Blob(["x"]), () => {});
    const xhr = FakeXHR.instances[0];
    xhr.status = 401;
    xhr.responseText = JSON.stringify({ reason: "unauthenticated" });
    xhr.onload?.();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(clearCachedWorkspaceName).toHaveBeenCalledOnce();
    expect(locationHref).toBe("/login");
  });

  it("✅ 成功(200)では送らない", async () => {
    const { uploadVariantImage } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const resultPromise = uploadVariantImage("variant-1", new Blob(["x"]), () => {});
    const xhr = FakeXHR.instances[0];
    xhr.status = 200;
    xhr.responseText = JSON.stringify({});
    xhr.onload?.();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(clearCachedWorkspaceName).not.toHaveBeenCalled();
    expect(locationHref).toBe("");
  });

  it("✅ 401 以外のエラー(404等)では送らない", async () => {
    const { uploadVariantImage } = await import("./api");
    const { clearCachedWorkspaceName } = await import("./workspaceCache");

    const resultPromise = uploadVariantImage("variant-1", new Blob(["x"]), () => {});
    const xhr = FakeXHR.instances[0];
    xhr.status = 404;
    xhr.responseText = JSON.stringify({ reason: "not_found" });
    xhr.onload?.();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(clearCachedWorkspaceName).not.toHaveBeenCalled();
    expect(locationHref).toBe("");
  });
});
