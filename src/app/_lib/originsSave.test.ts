import { describe, expect, it } from "vitest";
import { saveOrigins } from "./originsSave";

describe("saveOrigins", () => {
  it("PUT成功・再取得も成功 → 再取得の値(サーバーの最新値)を使う", async () => {
    const result = await saveOrigins(["https://a.com"], {
      put: async () => ({ ok: true }),
      reload: async () => ({ ok: true, allowedOrigins: ["https://a.com", "https://server-added.com"] }),
    });
    expect(result).toEqual({ ok: true, allowedOrigins: ["https://a.com", "https://server-added.com"] });
  });

  it("PUT成功・直後の再取得は失敗 → PUTで送った配列をそのまま使う(再取得の失敗に引きずられない)", async () => {
    const result = await saveOrigins(["https://a.com"], {
      put: async () => ({ ok: true }),
      reload: async () => ({ ok: false }),
    });
    expect(result).toEqual({ ok: true, allowedOrigins: ["https://a.com"] });
  });

  it("PUT失敗(400) → エラーを返す(allowedOriginsは返さない)", async () => {
    const result = await saveOrigins(["https://a.com"], {
      put: async () => ({ ok: false, status: 400 }),
      reload: async () => {
        throw new Error("PUTが失敗したら再取得を呼んではいけない");
      },
    });
    expect(result).toEqual({ ok: false, error: "入力内容を確認してください" });
  });

  it("PUT失敗(400以外) → 「もう一度お試しください」系のメッセージ", async () => {
    const result = await saveOrigins(["https://a.com"], {
      put: async () => ({ ok: false, status: 500 }),
      reload: async () => ({ ok: true, allowedOrigins: [] }),
    });
    expect(result).toEqual({ ok: false, error: "保存できませんでした。もう一度お試しください。" });
  });

  /*
    🔴 再現: 追加→直後の再取得が失敗→続けて削除、
    という順序で、直前の追加が消えずに残ることを確かめる。`tags/page.tsx` の
    `handleAddOrigin`/`handleRemoveOrigin` と同じ手順(「今の画面の値」から次に送る配列を
    計算してから `saveOrigins` を呼ぶ)をそのまま再現する。
  */
  it("再現: 追加→再取得失敗→続けて削除、のシーケンスで直前の追加が消えない", async () => {
    let allowedOrigins = ["https://existing.com"];

    // 1. https://a.com を追加。PUTは成功するが、直後の再取得はわざと失敗させる。
    const addResult = await saveOrigins([...allowedOrigins, "https://a.com"], {
      put: async () => ({ ok: true }),
      reload: async () => ({ ok: false }),
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) throw new Error("unreachable");
    allowedOrigins = addResult.allowedOrigins;
    expect(allowedOrigins).toEqual(["https://existing.com", "https://a.com"]);

    // 2. 続けて https://existing.com を削除。「今の画面の値」(=直前の結果)から計算する。
    let sentToSecondPut: string[] | null = null;
    const removeResult = await saveOrigins(
      allowedOrigins.filter((o) => o !== "https://existing.com"),
      {
        put: async (sent) => {
          sentToSecondPut = sent;
          return { ok: true };
        },
        reload: async () => ({ ok: false }),
      },
    );
    expect(removeResult.ok).toBe(true);
    if (!removeResult.ok) throw new Error("unreachable");

    // 🔴 直前の追加(https://a.com)を含んだ配列がPUTされていること(古い配列で上書きしていない)。
    expect(sentToSecondPut).toEqual(["https://a.com"]);
    expect(removeResult.allowedOrigins).toEqual(["https://a.com"]);
  });

  /*
    🔴 「壊したら落ちることを1回確かめる」ための検査
    (`pageLoad.test.ts` と同じ形)。直す前の実装(PUTの成功を反映せず、再取得の成否だけに頼る)を
    模した版で、上の再現テストと同じシーケンスを流すと結果がずれることを確認する。
  */
  it("壊れた版(再取得が失敗したら送った配列を捨てて元のままにする)だと、再現と同じ結果にならない", async () => {
    async function brokenSaveOrigins(
      prevOrigins: string[],
      nextOrigins: string[],
      deps: { put: (o: string[]) => Promise<{ ok: boolean }>; reload: () => Promise<{ ok: boolean; allowedOrigins?: string[] }> },
    ): Promise<string[]> {
      const putResult = await deps.put(nextOrigins);
      if (!putResult.ok) return prevOrigins;
      const reloadResult = await deps.reload();
      // 🔴 ここが壊れている: PUTが成功していても、再取得が失敗したら「元のまま」に戻してしまう
      //   (直したバージョンは nextOrigins を使う)。
      return reloadResult.ok && reloadResult.allowedOrigins ? reloadResult.allowedOrigins : prevOrigins;
    }

    let allowedOrigins = ["https://existing.com"];
    allowedOrigins = await brokenSaveOrigins(allowedOrigins, [...allowedOrigins, "https://a.com"], {
      put: async () => ({ ok: true }),
      reload: async () => ({ ok: false }),
    });
    // 壊れた版では、PUTが成功したのに画面上は追加前のまま(直したバージョンと食い違う)。
    expect(allowedOrigins).toEqual(["https://existing.com"]);
    expect(allowedOrigins).not.toEqual(["https://existing.com", "https://a.com"]);
  });
});
