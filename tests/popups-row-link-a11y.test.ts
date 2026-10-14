// @vitest-environment node
//
// 🔴🔴 デザイン一覧(1280px の表)の行は、以前
// `<tr tabIndex={0} onKeyDown={...}>` という形で「トグル(Space)・削除(Enter)にフォーカスした
// 状態でキーを押すと、そのキー入力(keydown)が `<tr>` まで伝播して誤って詳細へ遷移する」
// ・「`<tr>` はネイティブにlink/buttonのロールを持たず支援技術にリンクとして伝わらない」という
// 2つの欠陥を持っていた(`click`用の`stopPropagation`は`keydown`の伝播を止められない。
// 実機=wrangler dev + Playwrightで「削除ボタンにフォーカスしてEnter」が詳細へ誤って遷移することを
// 実際に再現してから直した)。
//
// 直した内容: キャンペーン名を本物の `<a>`(詳細へのリンク)にし、キーボード操作の入口はそちらだけに
// する。`<tr>` の `onClick` はマウスでの「行のどこを押しても開く」ための便宜として残すが、
// `tabIndex`/`onKeyDown` は外した。
//
// このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照)ため、
// `sidebar-links-guarded.test.ts` と同じ考え方で「同じ欠陥が再び紛れ込んでいないか」を
// **ソースの字面**で機械的に検査する。コメント中の `<tr>` という文字列(この説明コメント自身を含む)
// を誤って本物のJSXと数えないよう、まずコメントを取り除く。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 🔴 サイドバー(AppShell)を `(app)/layout.tsx` に1回だけ置く変更で、
//   `src/app/(app)/popups/page.tsx` へ移った(ルートグループ。URL自体は変わらない)。
const FILE = path.resolve(__dirname, "../src/app/(app)/popups/page.tsx");

/** `sidebar-links-guarded.test.ts` と同じ考え方: ブロック・行コメントを取り除いたコードだけを返す。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function code(): string {
  return stripComments(readFileSync(FILE, "utf8"));
}

/** 実際の `<tr ...>` タグ(属性部分)だけを取り出す(コメント除去後のコードから)。 */
function trOpenTags(source: string): string[] {
  return [...source.matchAll(/<tr\b[^>]*>/g)].map((m) => m[0]);
}

describe("デザイン一覧(1280px の表)の行は、キー入力の入口を <a> だけに持つ", () => {
  it("🔴 <tr> に tabIndex を持つものが無い(行自体をフォーカス可能なリンク/ボタンのように見せない)", () => {
    const tags = trOpenTags(code());
    expect(tags.length, "<tr> が1つも見つからない = 何も測っていない").toBeGreaterThan(0);
    const withTabIndex = tags.filter((t) => /tabIndex/.test(t));
    expect(withTabIndex, `tabIndex を持つ<tr>:\n${withTabIndex.join("\n")}`).toEqual([]);
  });

  it("🔴 <tr> に onKeyDown を持つものが無い(キー入力はネイティブな <a>/<button> に任せる)", () => {
    const tags = trOpenTags(code());
    const withOnKeyDown = tags.filter((t) => /onKeyDown/.test(t));
    expect(withOnKeyDown, `onKeyDown を持つ<tr>:\n${withOnKeyDown.join("\n")}`).toEqual([]);
  });

  it('🔴 キャンペーン名が本物のリンク(href="/popup?id=...")で描かれている(詳細への実リンク)', () => {
    // 🔴 `/popup` も含め全ページ同士の遷移をソフトにした(_lib/popupEditSession.ts で
    //   編集中の入力をsessionStorageに保存して復元するため、フルリロードの境界が不要になった)。
    //   `GuardedLink`(内部は `<a href>` + ソフト遷移)を経由する——href自体は残るのでキーボード・
    //   支援技術・右クリックでの新規タブは今までどおり効く。
    expect(code()).toMatch(/<GuardedLink\s+href=\{`\/popup\?id=\$\{popup\.id\}`\}/);
    expect(code()).not.toMatch(/window\.location\.href = `\/popup\?id=\$\{popup\.id\}`/);
  });

  it("⚠ 行の onClick(マウスの便宜)は削りすぎていない(desktop <tr> に残っている)", () => {
    const tags = trOpenTags(code());
    const withOnClick = tags.filter((t) => /onClick/.test(t));
    expect(withOnClick.length, "onClick を持つ<tr>が無い = 行クリックでの遷移が消えている").toBeGreaterThan(0);
  });

  it("⚠ 変異検査: この検査自体が効いているか(素の tabIndex 付き<tr>を1つ差し込むと落ちる)", () => {
    const withTabIndex = trOpenTags('before <tr tabIndex={0} className="x"> after');
    expect(withTabIndex.some((t) => /tabIndex/.test(t))).toBe(true);
  });
});
