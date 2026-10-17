/*
  ポップの DOM(`<style>` と要素)を組み立てる**純粋な関数**。MIT(このディレクトリのみ)。

  🔴 `runtime.ts` の `draw()` から「組み立てるだけ」の部分を切り出した。
    ここに残っていないもの(呼び出し側=`draw()`に残した): 計測の送信・`bridge.onShown`・
    フォーカスの移動と戻し・Esc / 背景タップ / 閉じるの処理・画像の読み込み待ち・`bridge` の排他。
    **DOM を組んで返すだけ**で、`appendChild` で文書へ挿すのも呼び出し側の仕事(画像の読み込みを
    待つ関係で、挿すタイミングは呼び出し側が決める)。
  🔴 **画像 URL は呼ぶ側が解決して渡す**。このモジュールは `imageUrlOf` も `deliveryOrigin` も
    知らない —— ここでは `<img>` を**組むだけ**で `src` は付けない(`img.src` を設定するのは
    呼び出し側。読み込みの成否を待つ関係で、`load`/`error` の listener を先に付ける必要があり、
    その順番の管理は呼び出し側の責務のまま)。管理画面のプレビュー(別PR)は、同じ `imageElement`
    を受け取って配信元の URL か `blob:` URL を自分で設定すればよい(「写さず同じものを使う」方針)。
  🔴 **文字数の切り詰め・既定のボタン文言はこちら側**。
    プレビューと実物が同じ入力から同じ表示結果になるようにするため。
  ⚠ **任意 HTML を1文字も受け取らない**。見出し・本文・ボタン文言は
    `textContent` にしか入れない。`innerHTML` を使わない。
*/
import { TEXT_LIMITS } from "./bridge";
import { textOf } from "./frequency";

/** 仮置きの文言。⚠ **設定に文言が無いときだけ**使う(内部用語を出さない)。 */
export const FALLBACK_BUTTON_LABEL = "詳しく見る";
export const DIALOG_LABEL = "お知らせ";

/*
  🔴 **`rem`/`em` を1つも使わない**。`rem` は文書ルート(`<html>`)の
    `font-size` を基準にする —— `:host { all: initial }` は `:host` 自身の継承プロパティを遮るだけで、
    **`rem` の基準点(ルート要素)までは遮らない**。埋め込み先が `html { font-size: 10px }` のような
    LP だと、`2.75rem` は 44px ではなく 27.5px になり、「閉じるボタンは44px以上」が崩れる。
    **寸法は全部 px の絶対値**にする(1rem=16px だった値をそのまま px に置き換えた。見た目は変わらない)。
  ⚠ `vh`(`.image` の `max-height`)はビューポート基準で、文書ルートの `font-size` に左右されないので対象外。

  ⚠ 以下の `STYLE` 文字列はそのまま埋め込みバンドルに入って全 LP に配信されるため、
    CSS コメントは置かない(バンドルを無駄に太らせる)。各ルールの意図はここに書く:

  - `.backdrop.preview-flat`: 管理画面のプレビュー専用クラス。プレビューは `.backdrop` 要素ごと
    消さない(`font-family`/`line-height`/`color` の継承元が消えると実物と見た目が食い違うため)。
    固定配置・暗い背景・最前面だけをこのクラスで打ち消す。CSP の `style-src`(インライン style 不可)
    の下でも、JS で `style.property=` を書かずにクラス付与だけで切り替えられる
    (`src/app/_lib/popupPreview.ts` 参照)。
  - `.cta` の `box-sizing: border-box`: `min-height` は意匠ではなく**タッチターゲットの下限**(44px)。
    `:host { all: initial }` は Shadow DOM 内の継承を初期値に戻すだけで、`box-sizing` の既定
    (`content-box`)自体は変えない。`content-box` では `min-height` が**パディングを含まない内容部分**
    にしか効かず、上下の padding(16px分)がその外側に積み増される(実機で見た目の高さが約60pxに
    なっていた=44px(min-height) + 16px(padding))。`border-box` を足すと `min-height` がパディングを
    含む全体の高さに効くようになり、見た目の高さが44pxちょうどになる。
  - `.cta:focus-visible, .close:focus-visible`: フォーカスリングを消さない(キーボードで操作できることが分かる)。
  - `.image-panel`〜`.image-overlay`: 画像型(バナー/GIF)用。画像の高さは固定しない —— 比率どおりに
    高さが決まり、画面の高さの70%(スマホで検算した値)を超えたときだけ縮んで、そのときだけ左右に
    余白が出る(帯は出さない)。「GIF」の印は出さない(訪問者には不要。管理画面側の種類の印は別で、
    LP の見た目には影響しない)。寸法は実寸モックに合わせた値で、テキスト型(320px/角丸8px)とは別。
  - `.close-image`: 閉じるボタンは画像に重なるため独立した要素(押し間違えない間隔・44px 以上を維持)。
    テキスト型の `.close` と**同じ字形・大きさ・濃い色**(#1a1a1a・font-size 16px)・丸や塗りの面を
    作らない。訪問者が自由に選ぶ画像は暗いものもあるため、暗い画像の上で消えないよう `text-shadow`
    の白いにじみ(薄いグロー)だけを足す(輪郭線のような疑似ストロークは作らない)。
  - `.close`/`.close-image` の `top/right`(角へ寄せた): 押せる範囲(44px)は保ったまま、字の
    見た目の位置を角に近づけた。`.close` は `top/right: 0`——`.panel` が `overflow` を
    指定していないので、箱を 0 まで寄せても見切れない。`.close-image` は `top/right: 2px`
    (0ではなく少し内側)——`.image-panel` が `overflow: hidden` + `border-radius: 16px` を
    持つため、箱を角の真上(0,0)に置くとキーボードフォーカスの外枠(`outline-offset: 2px`
    だと箱の外側4pxまで広がる)の上辺・右辺が角丸のカーブで直線に欠けることを実測(390px・
    Tabキーでのフォーカス)で確認した。2px内側に置いたうえで `:focus-visible` の
    `outline-offset` を負(-4px)にして箱の**内側**に描く(負の `outline-offset` は仕様上
    必ず要素の境界の内側に描かれるため、箱が `.image-panel` の内側にある限り外枠も角丸の
    カーブに掛からない。実測した画像サイズ〈390px・640×420のSVG〉ではどちらも欠けなかった)。
    ×の文字自体は箱の中心(角から22px強)にあり角丸の半径(16px)より十分外側なので、
    実測(明るい/暗い画像・390px)で字自体は欠けないことを確認した。クリックは
    要素そのもの(`closeButton`)が受けるので、位置を角へ寄せても `runtime.ts` の「`backdrop`
    自身をクリックしたら閉じる」には影響しない(`closeButton` は `backdrop` ではなく `panel` の子)。
  - `.headline` の `padding-right: 32px`: 閉じる×を角へ寄せたことで、長い見出し(最大300字。
    `TEXT_LIMITS.headline`)の1行目が×の下を通って重なることを実機(390px)で確認した(×を
    角へ寄せる前の位置でも同じ重なりが既に起きていたことも確認済み=この余白は今回の変更で
    新しく生まれた不具合ではなく、角寄せを機に直した既存の重なり)。×の箱(44px)の左端は
    panel の padding-right(16px)の分だけ内側にあるので、見出しの padding-right はその差分
    (44-16=28px)を少し超える値にして、実際の×の字(箱の中心)より手前で確実に折り返す。
    `.footer .headline` は×が画像に重ねてあるだけ(フッターの真下ではない)ので 0 に戻す。
  - `.backdrop.preview-flat` の `width: 100%`: 管理画面のプレビューで、下書き(まだ保存していない)
    パターンのプレビューが 1280px で極端に細い縦長になり、ボタン文言が1文字ずつ折り返す不具合が
    あった(保存済みのパターンは見出し・本文に実際の文字が入っているため起きなかった)。原因は
    `.panel` の `width: calc(100% - 32px)`——本番は `.backdrop` が `position: fixed; inset: 0`
    (=ビューポート幅という確定した値)を持つのでこの % は解決できるが、プレビュー
    (`.preview-flat`)は `position: static` にした時点でその基準を失い、`width` を指定していない
    `.backdrop` は自分を包む Shadow DOM の host 要素(flex item)の内容に基づく shrink-to-fit で
    幅が決まる。その不確定な基準に対して `.panel` の % は仕様上「auto」扱いになり、幅が自分の
    中身の最小/最大コンテンツ幅まで遡って決まり直す——見出し・本文に実際の文章がある保存済み
    パターンは、その文章の方が 320px の max-width より広いため結果的に 320px でクランプされて
    たまたま正しく見えていたが、下書き(見出し・本文が空、ボタン文言も既定文言のみ=1文字ずつ
    どこでも折り返せる)はその中身の最小幅まで縮み、極端に細くなっていた。直し方は
    `.backdrop.preview-flat` に `width: 100%` を足し、host 側にも `w-full` を足すこと
    (`src/app/_lib/popupPreview.ts` 参照。host 自身が shrink-to-fit のままだと基準先が
    依然不確定なまま)。これで `.panel` の % は「host(=React側が確保した定幅の枠)の幅」という
    確定した基準から解決されるようになる。実測(1280px・390px、保存済み/下書き、テキスト型/
    画像型)では、どの組み合わせでも panel が同じ幅(300px)になり、中身の量による違いは
    出なかった。
  - `.close + .body, .close + .cta` の `margin-top: 28px`: 見出しが無いテキスト型(本文のみ、
    または本文もボタン文言も既定のみ)では、×の直後に続く要素が `.body` か `.cta` になる
    (DOM順は常に `closeButton` → [`.headline`] → [`.body`] → `.cta`)。見出しがある場合は
    `.headline` の `padding-right` で水平方向に避けるが、`.body` や `.cta` は幅いっぱいに
    広がる要素で左右では避けられないため、×の高さ(44px)が `.panel` の `padding-top`(20px)
    を超える分(44-20=24px)より大きい余白を縦に確保して、×の下を通らないようにする。見出し
    ありの場合は対象外(`.close + .headline` は選ばない)——見出しの行は水平に避けているので
    縦の余白まで足すと見出し前の空白が不自然に広がる。
*/
export const STYLE = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6; color: #1a1a1a;
}
.backdrop.preview-flat { position: static; inset: auto; z-index: auto; background: none; width: 100%; }
.panel {
  position: relative; box-sizing: border-box;
  width: calc(100% - 32px); max-width: 320px;
  background: #fff; border: 1px solid #d4d4d4; border-radius: 8px;
  padding: 20px 16px 16px;
}
.headline { margin: 0 0 8px; padding-right: 32px; font-size: 16px; font-weight: 700; }
.body { margin: 0 0 16px; font-size: 14px; }
.close + .body, .close + .cta { margin-top: 28px; }
.cta {
  box-sizing: border-box;
  display: flex; align-items: center; justify-content: center; min-height: 44px;
  text-align: center; text-decoration: none;
  padding: 8px 16px; border-radius: 6px;
  background: #1a1a1a; color: #fff; font-size: 14px; font-weight: 700;
}
.close {
  position: absolute; top: 0; right: 0;
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 6px;
  font-size: 16px; color: #1a1a1a; cursor: pointer;
}
.cta:focus-visible, .close:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }

.image-panel {
  padding: 0; max-width: 352px; border: 0; border-radius: 16px; overflow: hidden;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,.25), 0 8px 10px -6px rgba(0,0,0,.2);
}
.image-link { position: relative; display: block; }
.image-link:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
.image {
  display: block; width: 100%; height: auto; max-height: 70vh;
  object-fit: contain; background: #f2f1ec;
}
.image-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0); pointer-events: none;
  transition: background-color .15s;
}
.image-link:hover .image-overlay { background: rgba(0,0,0,.18); }
@media (prefers-reduced-motion: reduce) { .image-overlay { transition: none; } }
.close-image {
  position: absolute; top: 2px; right: 2px;
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 6px;
  font-size: 16px; color: #1a1a1a; cursor: pointer;
  text-shadow:
    0 0 1px rgba(255,255,255,1), 0 0 2px rgba(255,255,255,1), 0 0 4px rgba(255,255,255,1),
    0 0 7px rgba(255,255,255,.9), 0 0 11px rgba(255,255,255,.7);
}
.close-image:hover { opacity: .8; }
.close-image:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
.footer { padding: 20px 16px 16px; }
.footer .headline { margin: 0 0 12px; padding-right: 0; }
.footer .cta { margin: 0; }
`;

/** `draw()` が受け取る、表示してよい形へ落とす**前**の中身。サーバー応答由来 = 信用しない。 */
export type PopupViewContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageAlt?: unknown;
};

export type PopupViewInput = {
  kind: string;
  content: PopupViewContent;
  destinationUrl: string;
};

export type PopupView = {
  /** `attachShadow` 済みの要素。これを文書へ `appendChild` するのは呼び出し側。 */
  host: HTMLDivElement;
  shadow: ShadowRoot;
  panel: HTMLDivElement;
  backdrop: HTMLDivElement;
  closeButton: HTMLButtonElement;
  /** テキスト型の遷移ボタン、または画像型のフッターのボタン。無ければ `null`。 */
  cta: HTMLAnchorElement | null;
  /** 画像型のみ。画像全体を覆うリンク。 */
  imageLink: HTMLAnchorElement | null;
  /** 画像型のみ。`src` はまだ付けていない(読み込みの成否を待つのは呼び出し側)。 */
  imageElement: HTMLImageElement | null;
};

/**
 * ポップの DOM を組み立てて返す(**挿入はしない**)。見た目と動きは既存の `draw()` と同一。
 */
export function buildPopupView(doc: Document, input: PopupViewInput): PopupView {
  const content = input.content;
  const headline = textOf(content.headline, TEXT_LIMITS.headline);
  const body = textOf(content.body, TEXT_LIMITS.body);
  const rawButtonLabel = textOf(content.buttonLabel, TEXT_LIMITS.buttonLabel);
  const buttonLabel = rawButtonLabel || FALLBACK_BUTTON_LABEL;
  const imageAlt = textOf(content.imageAlt, TEXT_LIMITS.imageAlt);
  const isImage = input.kind === "image";

  const host = doc.createElement("div");
  // ⚠ LP の CSS が拾える手掛かりを残す(ポップの存在は隠さない)。
  //   旧名 `data-adpop` は、すでに LP 側の CSS がそれを指していても効き続けるよう当面維持する(同じ要素に両方付ける)。
  host.setAttribute("data-exit-popup", "");
  host.setAttribute("data-adpop", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = doc.createElement("style");
  style.textContent = STYLE;
  shadow.appendChild(style);

  const backdrop = doc.createElement("div");
  backdrop.className = "backdrop";

  const panel = doc.createElement("div");
  panel.className = isImage ? "panel image-panel" : "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const closeButton = doc.createElement("button");
  closeButton.className = isImage ? "close-image" : "close";
  closeButton.type = "button";
  // 🔴 記号だけに意味を持たせない —— スクリーンリーダーには「閉じる」と読ませる
  closeButton.setAttribute("aria-label", "閉じる");
  closeButton.textContent = "✕";

  let heading: HTMLHeadingElement | null = null;
  if (headline !== "") {
    heading = doc.createElement("h2");
    heading.className = "headline";
    heading.id = "adpop-headline";
    heading.textContent = headline;
  }

  // ダイアログの名前。見出し > (画像型なら)画像の説明 > 既定の "お知らせ" の順(二重に読ませない)。
  if (heading !== null) {
    panel.setAttribute("aria-labelledby", heading.id);
  } else if (isImage && imageAlt !== "") {
    panel.setAttribute("aria-label", imageAlt);
  } else {
    panel.setAttribute("aria-label", DIALOG_LABEL);
  }

  // 画像リンクの名前(アクセシブルネーム)。**空にはしない**(imageAlt → headline → buttonLabel の順)。
  const imageLinkLabel = imageAlt || headline || buttonLabel;

  let imageLink: HTMLAnchorElement | null = null;
  let imageElement: HTMLImageElement | null = null;
  let cta: HTMLAnchorElement | null = null;

  if (isImage) {
    /*
      ── 画像型(実寸モックの決定に合わせた)─────────────────────────
      🔴 **画像全体が1つのリンク**(運営者指示「画像やGIF自体がボタンの役割を果たす」)。
        ボタンは任意 —— ボタン文言が空なら画像だけのバナー、入っていれば画像の下にも同じ遷移先の
        ボタンを出す(同じ href を指す**別々の `<a>`**。入れ子にしない)。
    */
    imageLink = doc.createElement("a");
    imageLink.className = "image-link";
    imageLink.href = input.destinationUrl;
    imageLink.rel = "noopener noreferrer";
    imageLink.setAttribute("aria-label", imageLinkLabel);

    imageElement = doc.createElement("img");
    imageElement.className = "image";
    // ⚠ 画像の説明は <a> の aria-label が持つ(1つの画像に2つの名前を付けない)
    imageElement.alt = "";
    // 🔴 `src` はまだ付けない。読み込みの成否を待つのは呼び出し側。
    imageLink.appendChild(imageElement);

    const overlay = doc.createElement("div");
    overlay.className = "image-overlay";
    imageLink.appendChild(overlay);

    panel.appendChild(imageLink);
    panel.appendChild(closeButton);

    // フッター(見出し・ボタン)。どちらも無ければフッターそのものを出さない(画像だけのバナー)。
    if (heading !== null || rawButtonLabel !== "") {
      const footer = doc.createElement("div");
      footer.className = "footer";
      if (heading !== null) footer.appendChild(heading);
      if (rawButtonLabel !== "") {
        cta = doc.createElement("a");
        cta.className = "cta";
        cta.href = input.destinationUrl;
        cta.rel = "noopener noreferrer";
        cta.textContent = buttonLabel;
        footer.appendChild(cta);
      }
      panel.appendChild(footer);
    }
  } else {
    // ── テキスト型(既存の見た目)────────────────────────
    panel.appendChild(closeButton);
    if (heading !== null) panel.appendChild(heading);

    if (body !== "") {
      const paragraph = doc.createElement("p");
      paragraph.className = "body";
      paragraph.textContent = body;
      panel.appendChild(paragraph);
    }

    cta = doc.createElement("a");
    cta.className = "cta";
    // 🔴 描画の直前にもう一度確かめた URL しかここへ来ない(呼び出し側の isSafeDestination)
    cta.href = input.destinationUrl;
    cta.rel = "noopener noreferrer";
    cta.textContent = buttonLabel;
    panel.appendChild(cta);
  }

  backdrop.appendChild(panel);
  shadow.appendChild(backdrop);

  return { host, shadow, panel, backdrop, closeButton, cta, imageLink, imageElement };
}
