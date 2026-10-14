// @vitest-environment node
//
// Regression guard: this is a public OSS repository. Management IDs, document
// names and people/team names from the maintainer's private working process,
// and the name of another product, must never appear in the tracked tree
// (path or content) — none of it means anything to an outside reader, and some
// of it is private.
//
// 🔴 **The banned terms are built from Unicode code points / split ASCII
//   fragments, not written as literal substrings** — otherwise this guard file
//   itself would contain the exact strings it exists to forbid, and would
//   trip over its own rule (this has happened before).
// 🔴 **Every pattern checks both the path and the content of every tracked
//   file, including this file and `package-lock.json`.** A forbidden word
//   hiding only in a directory/file name, or only in a generated file that
//   got special-cased out of the scan, would otherwise go uncaught — this
//   file passes the same check it runs, with no self-exemption.
// 🔴 **`D-\d{3}` is checked with `\b` on both sides** so it doesn't fire on
//   unrelated digit runs (e.g. a word ending in a letter other than `D`
//   immediately followed by 3 digits has no word boundary there).
// ⚠ `docs/deploy.md`'s own section markers (`docs/deploy.md §N`, pointing at
//   itself) are not covered here — `§` alone isn't one of the forbidden terms,
//   it's this repo's own public doc using its own section numbers.
// ⚠ Limits of this check: it matches literal appearance only. A string
//   deliberately split across concatenated template literals at the exact
//   point this scanner doesn't look would not be caught.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => f.length > 0);
}

/** Builds a string from Unicode code points, so it never appears as a literal substring in this source file. */
function cp(...codePoints: number[]): string {
  return codePoints.map((c) => String.fromCodePoint(c)).join("");
}

/** Builds a string by joining ASCII fragments that are individually innocuous. */
function frag(...parts: string[]): string {
  return parts.join("");
}

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "internal decision ID (D-NNN style)", re: /\bD-\d{3}\b/ },
  // Japanese word for "the requester" (private-process jargon)
  { label: "internal term A", re: new RegExp(cp(0x4f9d, 0x983c, 0x8005)) },
  // Japanese for "screen design" (a private document series name)
  { label: "internal document name A", re: new RegExp(cp(0x753b, 0x9762, 0x8a2d, 0x8a08)) },
  // Japanese for "requirements doc" (a private document series name)
  { label: "internal document name B", re: new RegExp(cp(0x8981, 0x4ef6, 0x66f8)) },
  // Japanese for "headquarters" (a private role name)
  { label: "internal org name", re: new RegExp(cp(0x672c, 0x90e8)) },
  // an individual's given name, used nowhere in this repo
  { label: "internal person name", re: new RegExp(cp(0x62d3, 0x5b9f)) },
  // Japanese for "company president" (a private role title)
  { label: "internal role title A", re: new RegExp(cp(0x793e, 0x9577)) },
  // the name of an AI review tool used in the private working process
  { label: "internal tool name", re: new RegExp(frag("Co", "dex"), "i") },
  // another product's repo slug, lowercase form
  { label: "another product's name A", re: new RegExp(frag("nail", "karte"), "i") },
  // another product's public brand name, uppercase form
  { label: "another product's name B", re: new RegExp(frag("NK", "ARTE")) },
  // a private notes directory, as a path segment or literal mention
  { label: "internal vault path", re: new RegExp(frag("notes", "/")) },
  // a private throwaway-work directory, as a path segment or literal mention
  { label: "internal scratch directory name", re: new RegExp(frag("scratch", "pad")) },
  // "security" + U+76E3 U+67FB ("audit"), a private report series name
  // also matches the possessive form ("security" + no + audit)
  { label: "internal audit report reference", re: new RegExp(frag("security", "\\s*", cp(0x306e), "?\\s*") + cp(0x76e3, 0x67fb)) },
  // audit + finding number (e.g. a letter and digits right after the Japanese word for "audit")
  { label: "internal audit finding number", re: new RegExp(cp(0x76e3, 0x67fb) + "\\s*[A-Z]\\d+") },
  // review-process vocabulary: "N-th round", "previous round", "cross-review", "review finding", severity label
  { label: "review-process word: round", re: new RegExp(cp(0x5de1, 0x76ee)) },
  { label: "review-process word: previous round", re: new RegExp(cp(0x524d, 0x5de1)) },
  { label: "review-process word: cross-review", re: new RegExp(cp(0x30af, 0x30ed, 0x30b9, 0x30ec, 0x30d3, 0x30e5, 0x30fc)) },
  { label: "review-process word: review finding", re: new RegExp(cp(0x30ec, 0x30d3, 0x30e5, 0x30fc, 0x6307, 0x6458)) },
  { label: "review-process word: severity label", re: new RegExp(frag("Block", "er")) },
];

describe("tracked tree has no internal references", () => {
  const files = trackedFiles();

  it("scanned more than a handful of files (otherwise this check is watching nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const pattern of PATTERNS) {
    it(`🔴 ${pattern.label} appears in no tracked path or file`, () => {
      const hits: string[] = [];
      for (const file of files) {
        if (pattern.re.test(file)) {
          hits.push(`${file} (path)`);
          continue;
        }
        // Every tracked file must be readable as UTF-8 text for this check to
        // work; a read failure (e.g. genuinely binary content) is itself
        // surfaced below rather than silently skipped.
        // `readFileSync(..., "utf8")` never throws on binary content — it just
        // lossily decodes it — so there is nothing to "fail loudly" on here.
        // Reading every tracked file (including binaries) as text is cheap at
        // this repo's size and avoids an extension allowlist that could miss
        // a forbidden word hiding in a file type nobody thought to list.
        const text = readFileSync(path.join(ROOT, file), "utf8");
        if (pattern.re.test(text)) hits.push(`${file} (content)`);
      }
      expect(hits, `found in: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
