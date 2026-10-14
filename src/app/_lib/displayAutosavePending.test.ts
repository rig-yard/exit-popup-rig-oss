/*
  display/page.tsx の自動保存(トリガのON/OFF・閾値・頻度)を、**1本の直列キュー**
  (`singleFlightQueue.ts`)+ 「送る内容は常に ref から読む」+ 「待ち中の種類を1つのSetに集めて
  1件ずつ排出する」という形に統合してある。
  このファイルは、その統合パターンの核(「複数の異なる種類の保存が混ざっても、送る瞬間に
  最新の値を読むなら staleな値で上書きしない」「待ち中が無ければ何も送らない=離脱時の
  flushが新しい値を古い値で潰さない」)を、DOM・React無しで固定する。
*/
import { describe, expect, it } from "vitest";
import { createSingleFlightQueue } from "./singleFlightQueue";

type Store = Record<string, string>;

describe("display/page.tsx の自動保存(トリガ・閾値・頻度を1本の直列キューに統合)", () => {
  it("🔴 直す前(赤): 項目ごとに「スケジュールした時点の値」を閉じ込めて送ると、古い値で上書きする", async () => {
    // 旧実装の再現: `scheduleAutosave(key, () => saveThreshold(kind))` は、スケジュールした瞬間の
    // クロージャに閾値の値を暗黙に閉じ込める(実際にはReactの再レンダーで最新化されるが、
    // ここでは「スケジュール時点の値をそのまま持ち歩く」設計に単純化して再現する——
    // 2つの項目をほぼ同時に確定したとき、後に送った方の応答が先に処理されて、先に送った方の
    // (スケジュール時点では正しかったが、今はもう古い)値が最後に上書きしてしまう型)。
    const sent: string[] = [];
    let confirmed: Store = { a: "0", b: "0" };
    async function scheduleWithCapturedValue(key: string, capturedValue: string, respondAfterMs: number) {
      sent.push(`${key}=${capturedValue}`);
      await new Promise((r) => setTimeout(r, respondAfterMs));
      confirmed = { ...confirmed, [key]: capturedValue };
    }
    // Aを確定(応答が遅い)の直後に、Aをもう一度(ユーザーが思い直して)別の値へ確定(応答が速い)。
    const p1 = scheduleWithCapturedValue("a", "1", 50);
    const p2 = scheduleWithCapturedValue("a", "9", 10);
    await Promise.all([p1, p2]);
    // 応答順(2が先・1が後)で上書きされ、最後に確定したつもりの"9"ではなく"1"が残ってしまう。
    expect(confirmed.a, "旧方式の再現: 最後に確定した値(9)ではなく、先に発行した古い値(1)が残る").toBe("1");
  });

  it("✅ 直した後(緑): 1本の直列キュー + 送る瞬間にrefから読む なら、混在する種類でも常に最新が残る", async () => {
    // 新実装の再現: 「待ち中の種類」をSetに集め、キューが1件ずつ排出する。各送信は
    // 「送る瞬間」にstore(refの代わり)から最新値を読む——スケジュール時点の値を持ち歩かない。
    const store: Store = { "threshold:a": "0", frequency: "0" };
    const sent: string[] = [];
    const confirmed: Store = {};
    const pending = new Set<string>();

    const queue = createSingleFlightQueue(async () => {
      while (pending.size > 0) {
        const id = pending.values().next().value as string;
        pending.delete(id);
        const latest = store[id]; // 🔴 送る瞬間に読む(スケジュール時点ではない)
        sent.push(`${id}=${latest}`);
        await new Promise((r) => setTimeout(r, 10));
        confirmed[id] = latest;
      }
    });
    function schedule(id: string) {
      pending.add(id);
      void queue.trigger();
    }

    store["threshold:a"] = "1";
    schedule("threshold:a");
    store.frequency = "2"; // 別の種類が、閾値の送信中に確定する
    schedule("frequency");
    store["threshold:a"] = "9"; // さらに、閾値が送信中にもう一度確定し直される
    schedule("threshold:a");

    await new Promise((r) => setTimeout(r, 100));

    expect(confirmed["threshold:a"], "閾値は最後に確定した値(9)が残る(古い1に戻らない)").toBe("9");
    expect(confirmed.frequency, "混在した別の種類(頻度)の確定も残る").toBe("2");
  });

  it("✅ 待ち中(pending)が無ければ、離脱時のflushは何も送らない(dirtyでなければ古い値で上書きしない)", () => {
    const pending = new Set<string>();
    const sentOnFlush: string[] = [];
    function flushPendingNow() {
      if (pending.size === 0) return; // 🔴 未送信の変更が無ければ送らない
      for (const id of pending) sentOnFlush.push(id);
      pending.clear();
    }

    // 何も確定していない(全部送信済み)状態で離脱。
    flushPendingNow();
    expect(sentOnFlush, "送るものが無いときは1件も送らない(別タブの新しい値を古い値で潰さない)").toEqual([]);

    // 確定したがまだ送っていないものがある状態で離脱。
    pending.add("threshold:a");
    flushPendingNow();
    expect(sentOnFlush).toEqual(["threshold:a"]);
  });
});
