// @vitest-environment node
//
// 🔴 全ページの移動をソフト遷移にする変更で、`/display`・`/popup` の
// `onBeforeLeave`/`pendingLeave`/`UnsavedChangesDialog`(サイドバー等の離脱確認)を撤去した
// ——編集中の入力をsessionStorage(`_lib/popupEditSession.ts`)に保存して戻ってきたら復元する
// 作り(/popup)・自動保存で未保存の状態を持たない作り(/display)に変えたため、確認そのものが
// 不要になった。この検査が固定していた「入口はblocksLeavingだけで決める」「保存完了時に
// 自動遷移しない」は、その入口自体が無くなったので検査の対象が消えた。
// `togglingKinds`/`isBusy` に関する検査
// (離脱確認とは無関係に、PUT進行中の二重送信防止を固定するもの)はそのまま残す。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  🔴 表示設定のトグル保存(`toggleTrigger`)は即時保存だが、
  PUT が進行中でも進行中の集合に入っていなかった(未保存の確認を経由しない・進行中の
  リクエストが中断される)。離脱確認の仕組み自体は撤去してあり、保存(PUT)そのものを`toggleTrigger`から`sendToggle`(1本の直列キューが呼ぶ)へ
  分離したが、進行中追跡(`togglingKinds`)は変わらず残す——入口(`toggleTrigger`)で
  busyにし、実際にPUTする`sendToggle`の前後でクリアする。
*/
describe("表示設定のトグル(即時保存)は、PUTが進行中の間 togglingKinds に入る", () => {
  it("🔴 toggleTrigger は busy にしてから直列キューへ予約する", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/app/(app)/display/page.tsx"), "utf8");
    const start = source.indexOf("function toggleTrigger(");
    expect(start, "toggleTrigger が見つからない = 何も測っていない").not.toBe(-1);
    const end = source.indexOf("\n  }", start);
    const body = source.slice(start, end);
    expect(body, `toggleTriggerの中身:\n${body}`).toMatch(/setTogglingKinds[\s\S]*schedule\(/);
  });

  it("🔴 sendToggle は PUT の前後で togglingKinds を更新する(進行中を集計する)", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/app/(app)/display/page.tsx"), "utf8");
    const start = source.indexOf("async function sendToggle(");
    expect(start, "sendToggle が見つからない = 何も測っていない").not.toBe(-1);
    const end = source.indexOf("\n  }", start);
    const body = source.slice(start, end);
    expect(body, `sendToggleの中身:\n${body}`).toMatch(/putJson[\s\S]*setTogglingKinds/);
  });
});

/*
  🔴 同じトグルを保存中にもう一度押せてしまうと、
  PUT が並行して走り、先に終わった方が `togglingKinds` から kind を消して、もう片方が
  進行中でも `isBusy` が false に戻ってしまう(一覧の配信トグルと同じ扱いで、保存中は
  disabled にする必要がある)。`toggleTrigger` 自身の入り口のガードと、ボタンの `disabled`
  属性(`togglingKinds.has(kind)`)の両方を固定する。
*/
describe("表示設定のトグルは、保存中はdisabledになる(二重クリック・並行PUTを防ぐ)", () => {
  it("🔴 トグルの <button> に disabled={togglingKinds.has(kind)} が付いている", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/app/(app)/display/page.tsx"), "utf8");
    const start = source.indexOf('aria-label={`${TRIGGER_LABELS[kind]}を有効にする`}');
    expect(start, "トグルの <button> が見つからない = 何も測っていない").not.toBe(-1);
    const nearby = source.slice(start, start + 300);
    expect(nearby, `トグル周辺:\n${nearby}`).toMatch(/disabled=\{togglingKinds\.has\(kind\)\}/);
  });

  it("🔴 toggleTrigger は togglingKinds に既に入っている kind を無視する(入り口の二重防止)", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/app/(app)/display/page.tsx"), "utf8");
    const start = source.indexOf("function toggleTrigger(");
    const end = source.indexOf("\n  }", start);
    const body = source.slice(start, end);
    expect(body, `toggleTriggerの中身:\n${body}`).toMatch(/if \(togglingKinds\.has\(kind\)\) return;/);
  });
});
