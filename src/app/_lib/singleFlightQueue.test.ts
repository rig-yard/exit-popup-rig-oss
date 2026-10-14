import { describe, expect, it } from "vitest";
import { createSingleFlightQueue } from "./singleFlightQueue";

/** 任意の遅延で解決する約束を作る(応答順序を入れ替えて再現するため)。 */
function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("createSingleFlightQueue", () => {
  it("🔴 直す前(赤): 項目ごとに個別PUT + baselineマージという旧方式は、応答の順序が入れ替わると後から確定した値を消す", async () => {
    // display/page.tsx の旧実装(saveFrequencyField)の再現: 項目ごとに「その時点のbaseline」を
    // 読んでPUTし、応答が届いたらbaselineをその場で更新する。PUTの往復時間が項目ごとに違うと、
    // 後に発行したPUT(B)が先に応答してbaselineを進め、先に発行したPUT(A)の応答が後から届いて
    // 「Aを含むが、まだBを知らない古いbaseline」でbaselineを巻き戻してしまう。
    let baseline: Record<string, string> = { a: "0", b: "0" };
    const sentPayloads: Array<Record<string, string>> = [];
    async function saveField(key: "a" | "b", value: string, respondAfterMs: number) {
      const merged = { ...baseline, [key]: value }; // 🔴 その時点のbaselineを読む(古くなりうる)
      sentPayloads.push(merged);
      await delayed(null, respondAfterMs);
      baseline = merged; // 応答順に上書きする
    }

    // ユーザーがAをまず確定(応答が遅い)、直後にBを確定(応答が速い)。
    const pA = saveField("a", "1", 50);
    const pB = saveField("b", "2", 10);
    await Promise.all([pA, pB]);

    // Bの応答(先着)がbaselineを {a:"0", b:"2"} にした後、Aの応答(後着)が
    // {a:"1", b:"0"}(Aを発行した時点でまだBを知らない)で上書きし、Bの確定が消える。
    expect(baseline, "旧方式の再現: Bの確定(b=2)が消えて0に戻ってしまう").toEqual({ a: "1", b: "0" });
  });

  it("✅ 直した後(緑): createSingleFlightQueue + 常に最新を読む送信関数なら、どちらの確定も残る", async () => {
    // display/page.tsx の新実装(commitFrequency)の再現: 送る内容は毎回「今の最新の状態」を
    // 1つのrefから読む(キュー自身は「いつ呼ぶか」だけを直列化する)。
    const current: Record<string, string> = { a: "0", b: "0" };
    let confirmed: Record<string, string> | null = null;
    const sentPayloads: Array<Record<string, string>> = [];
    const queue = createSingleFlightQueue(async () => {
      const snapshot = { ...current }; // 実行される瞬間の最新値(応答待ちの間に変わっても次で拾う)
      sentPayloads.push(snapshot);
      await delayed(null, 30);
      confirmed = snapshot;
    });

    current.a = "1";
    const t1 = queue.trigger(); // 送信開始(a=1,b=0 を送る)
    current.b = "2"; // 送信中にbが変わる
    const t2 = queue.trigger(); // 送信中なので「終わったらもう一度」だけを予約する(並行送信しない)
    await Promise.all([t1, t2]);

    expect(confirmed, "両方の確定が反映されている(bが消えていない)").toEqual({ a: "1", b: "2" });
    expect(sentPayloads.length, "並行させず、1件ずつ(今回は2回=最初の送信+再送信)送っている").toBe(2);
  });

  it("送信中でなければ即座に実行する", async () => {
    let calls = 0;
    const queue = createSingleFlightQueue(async () => {
      calls += 1;
    });
    await queue.trigger();
    expect(calls).toBe(1);
    expect(queue.isRunning()).toBe(false);
  });

  it("送信中に3回triggerされても、終わった後の再送信は1回だけ(都度ではなく最後にまとめて)", async () => {
    let calls = 0;
    const queue = createSingleFlightQueue(async () => {
      calls += 1;
      await delayed(null, 10);
    });
    const first = queue.trigger();
    void queue.trigger();
    void queue.trigger();
    void queue.trigger();
    await first;
    // 最初の実行が終わった後、pendingRerun は1回分しか立たないので再実行は1回だけ
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
  });
});
