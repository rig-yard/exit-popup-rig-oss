// @vitest-environment node
//
// 凍結した表・列(popups の頻度列・popup_triggers・popup_mobile_*)を、**管理画面・配信のデータ層**が
// 読みも書きもしないこと(「凍結した表・列の扱い」)。
//
// 🔴 主な保証は `tests/d1-site-display.test.ts`(管理画面側。状態で測る: 凍結した表を直接書き換えても
//   `getPopup`/`listTriggers` の出力が変わらないこと)と `tests/d1-delivery.test.ts`(配信側。
//   同じ形で「凍結した表を直接書き換えても配信の応答が変わらない」を状態で測る)。ここは**補助**
//   (名指しした検査)で、対象のソースに凍結した表の名前が(この検査を除いて)現れないことを字面で見る。
// ⚠ スコープは **`src/lib/data/admin.ts` / `src/lib/data/images.ts` / `src/admin/` / `src/lib/data/delivery.ts`**。
//   🔴 `delivery.ts` もスコープに入っている——表示設定(きっかけ・頻度)の値の出どころを
//   `site_display_settings` / `site_display_triggers` に付け替えたため(値の出どころが変わった)。
// ⚠ この検査の限界: 見ているのは**識別子の出現**だけ。コメントは除外するが、
//   文字列結合で組み立てた表名(例: `"popup_" + "triggers"`)までは追えない。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

/** `//` と `/* *\/` を空白に置き換える。 */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    if (code[i] === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += code[i];
    i++;
  }
  return out;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// 🔴 スコープ = 管理画面・配信のデータ層・API(上の注記)
const SCOPE = [
  ...listTsFiles(path.join(ROOT, "src/admin")),
  path.join(ROOT, "src/lib/data/admin.ts"),
  path.join(ROOT, "src/lib/data/images.ts"),
  path.join(ROOT, "src/lib/data/delivery.ts"),
];

describe("凍結した表の名前が、管理画面・配信のデータ層・API に現れない(補助・字面)", () => {
  it("前提: 'site_display_triggers' は 'popup_triggers' を含まない(誤検出しない)", () => {
    expect("site_display_triggers").not.toContain("popup_triggers");
  });

  it.each(["popup_triggers", "popup_mobile_display", "popup_mobile_triggers"])(
    "🔴 %s は管理画面・配信のデータ層・API のコード(コメントを除く)に現れない",
    (name) => {
      const hits: string[] = [];
      for (const file of SCOPE) {
        const stripped = stripComments(readFileSync(file, "utf8"));
        if (stripped.includes(name)) hits.push(path.relative(ROOT, file));
      }
      expect(hits, `見つかった場所: ${hits.join(", ")}`).toEqual([]);
    },
  );

  it("🔴 admin.ts / delivery.ts は、popups の頻度の列をテーブル修飾(p.xxx / popups.xxx)で読まない", () => {
    const frequencyColumns = ["suppress_days", "session_impressions", "post_conversion_days", "min_display_delay_seconds"];
    for (const target of ["src/lib/data/admin.ts", "src/lib/data/delivery.ts"]) {
      const code = readFileSync(path.join(ROOT, target), "utf8");
      const offenders = frequencyColumns.filter((col) => new RegExp(`\\b(?:popups|p)\\.${col}\\b`).test(code));
      expect(offenders, `${target} に見つかった`).toEqual([]);
    }
  });
});
