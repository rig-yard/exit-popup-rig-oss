/*
  390px で主要な操作のタップ領域が44×44px未満だった
  (ポップカードの編集/停止/アーカイブ、トリガーのスイッチ、許可ドメインの削除ボタン等)。
  🔴 **見た目は変えない**(文字の大きさ・行間・配置は維持)という制約があるため、
  可視要素はそのまま、`::before` の絶対配置の透明な矩形でヒット領域だけを広げる
  (クリックは祖先の `<button>`/`<a>` にバブルするので、見た目に影響しない)。
  `relative` を前提にするので、既に `relative` を持つ要素には位置用のクラスを足さない。
*/

/**
 * テキストリンク・小さいボタン用。
 * 🔴 以前の `-inset-3.5`(左右14px)は、`gap-x-4`(16px)で並ぶ
 *   「編集/停止/アーカイブ」等の間で隣の疑似要素と約12px重なり、押し間違いが起きた
 *   (重なった領域はDOM順で後の要素が手前になる)。
 * 📌 **横は隣との間隔の半分まで(8px)にとどめて重ならないことを優先し、縦だけ44pxを確保する**
 *   。見た目の大きさ・位置は変えない。横の実効幅は要素によって44pxに届かないことがあるが、
 *   「重ならない」を優先する。
 */
export const TAP_TARGET_44 = "relative before:absolute before:-inset-y-3 before:-inset-x-2 before:content-['']";

/** 縦方向だけが足りない要素用(例: h-6 のトグルスイッチ)。横幅は変えずに高さだけ44pxに広げる。 */
export const TAP_TARGET_44_V = "relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']";

/**
 * アイコンのみの小さいボタン用(許可ドメインの削除 ✕ など)。
 * ⚠ 実測(Playwright): 「✕」の可視領域は幅7px・高さ16px程度しかなく、`-inset-4`(16px)では
 *   幅が 7+32=39px で44pxに届かなかった。`-inset-5`(20px)で 7+40=47px まで確保する。
 */
export const TAP_TARGET_44_ICON = "relative before:absolute before:-inset-5 before:content-['']";

/**
 * アイコンのみの操作ボタンが横に並ぶ場所用(例: ポップ一覧の編集/アーカイブ)。
 * ボタン自体が既に `h-9 w-9`(36×36px)あるため、`TAP_TARGET_44_ICON` の `-inset-5`(20px)を
 * そのまま使うと、隣のボタンとの隙間(8px程度)より疑似要素の拡張分が大きく、
 * 重なった領域ではDOM順で後のボタンが手前になり押し間違いが起きる(TAP_TARGET_44 と同じ型)。
 * 縦だけ `-inset-y-1`(4px)で44pxちょうどに、横も `-inset-x-1`(4px)にとどめ、
 * 隣接ボタンとの間隔(gap-2・8px)の半分までで重ならないようにする。
 */
export const TAP_TARGET_44_ICON_ADJACENT = "relative before:absolute before:-inset-y-1 before:-inset-x-1 before:content-['']";
