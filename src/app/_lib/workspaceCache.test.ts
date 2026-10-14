import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCachedWorkspaceName, readCachedWorkspaceName, writeCachedWorkspaceName } from "./workspaceCache";

function stubSessionStorage(impl: Partial<Storage>) {
  vi.stubGlobal("sessionStorage", impl as Storage);
}

describe("workspaceCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("書いた名前をそのまま読める", () => {
    const store = new Map<string, string>();
    stubSessionStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    });
    writeCachedWorkspaceName("テスト工房");
    expect(readCachedWorkspaceName()).toBe("テスト工房");
  });

  it("何も書いていなければ null", () => {
    stubSessionStorage({ getItem: () => null });
    expect(readCachedWorkspaceName()).toBeNull();
  });

  it("sessionStorage が無い環境(ReferenceError)でも例外を投げず null を返す", () => {
    // global に sessionStorage を一切定義しない = 参照すると ReferenceError
    expect(readCachedWorkspaceName()).toBeNull();
  });

  it("読み取りが例外を投げる(プライベートブラウジング等)環境でも null を返す", () => {
    stubSessionStorage({
      getItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(readCachedWorkspaceName()).toBeNull();
  });

  it("書き込みが例外を投げても呼び出し側に伝播しない", () => {
    stubSessionStorage({
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(() => writeCachedWorkspaceName("テスト工房")).not.toThrow();
  });

  it("clearCachedWorkspaceName は書いた名前を消す(ログアウト/ログイン時の漏れ対策)", () => {
    const store = new Map<string, string>();
    stubSessionStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    });
    writeCachedWorkspaceName("テスト工房");
    expect(readCachedWorkspaceName()).toBe("テスト工房");
    clearCachedWorkspaceName();
    expect(readCachedWorkspaceName()).toBeNull();
  });

  it("clearCachedWorkspaceName が例外を投げても呼び出し側に伝播しない", () => {
    stubSessionStorage({
      removeItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(() => clearCachedWorkspaceName()).not.toThrow();
  });
});
