#!/usr/bin/env node
/*
  埋め込みスクリプトを実際にビルドして、gzip 後の大きさを上限と突き合わせる。
  超えていたら**非ゼロで終わる**(CI が落ちる)。

  実物(束ねた `dist/`)を測っている。
    **判定そのもの**が正しいことは `tests/bundle-size.test.ts` が
    両側(超える / 超えない / 測れなかった)で固定している。
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLES, evaluateSizes, formatReport, gzipSizeOf } from "./bundle-size.mjs";
import { buildEmbedBundle, REPO_ROOT as ROOT } from "./embed-build.mjs";

const measured = {};
for (const bundle of BUNDLES) {
  const { code } = await buildEmbedBundle(bundle);
  const outPath = path.join(ROOT, bundle.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, code);
  measured[bundle.id] = gzipSizeOf(code);
}

const result = evaluateSizes(measured);
console.log("埋め込みスクリプトの大きさ(上限):");
console.log(formatReport(result));

if (!result.ok) {
  console.error("\n上限を超えています。依存を足していないか、本体をローダに混ぜていないかを見てください。");
  process.exit(1);
}
