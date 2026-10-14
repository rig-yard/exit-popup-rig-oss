/*
  管理画面のプレビュー。
  🔴 `packages/embed/src/popup-view.ts` の `buildPopupView()`(実物と同じ描画コード)を**そのまま**使う。
    ここで新しい見た目を作らない——プレビューと実物が食い違う一番の原因は「写し」を作ることなので、
    写さず同じ関数を呼ぶ(方針どおり)。
  このファイルが追加しているのは次の4つ:
    ① ページの枠・暗い背景・最前面固定を無効化する(「プレビューはポップ本体
       だけ」)。🔴 `.backdrop` 要素ごと消すと、
       `font-family`/`line-height`/`color`(popup-view.ts の `.backdrop` ルールにしか無い値)が
       失われ、プレビューがブラウザの既定フォント・既定行高になって LP の実物と見た目が食い違う。
       **`.backdrop` 要素自体は残し、`position`/`inset`/`z-index`/`background` だけを打ち消す**
       (`display:flex` 等のレイアウト・フォント継承はそのまま活かす)。
    ② リンク(cta・imageLink)のクリックで実際に遷移しないようにする(計測・遷移を一切行わない)
    ③ 画像のURL(配信元 or 未アップロードの blob:)を呼び出し側から渡してセットする
       (本物と同じ `<img>` 要素に対して。`src` を付けるタイミングの管理はここが引き継ぐ)
    ④ host に `inert` 属性を付け、プレビュー内の要素をクリック・タブ移動・スクリーンリーダーの
       対象から外す(①②の能動的な対処に対する保険の2重化——どちらかが漏れても他方が止める)
  ⚠ フォーカスは奪わない: `buildPopupView()` 自体は何もフォーカスしない(フォーカス移動は
    `runtime.ts` の `draw()` 呼び出し側だけが持つ処理で、ここでは呼んでいない)。④はその前提の上に
    置いた保険であって、フォーカス移動そのものをここが行っているわけではない。
*/
import { buildPopupView, type PopupViewInput } from "../../../packages/embed/src/popup-view";

export type PopupPreviewInput = {
  kind: string;
  headline: string;
  body: string;
  buttonLabel: string;
  imageAlt: string;
  destinationUrl: string;
  /** 配信元のURL、または未アップロードの画像の blob: URL。無ければ画像を表示しない(srcを付けない)。 */
  imageUrl: string | null;
};

export type PopupPreview = {
  /** `attachShadow` 済みの要素。挿入(`appendChild`)は呼び出し側の仕事(`buildPopupView` と同じ役割分担)。 */
  host: HTMLDivElement;
  /** 後始末(イベントリスナーの解除)。挿入した要素の取り外し自体は呼び出し側が行う。 */
  destroy: () => void;
};

/** プレビューの DOM を組み立てて返す(**挿入はしない**)。 */
export function buildPopupPreview(doc: Document, input: PopupPreviewInput): PopupPreview {
  const popupInput: PopupViewInput = {
    kind: input.kind,
    content: { headline: input.headline, body: input.body, buttonLabel: input.buttonLabel, imageAlt: input.imageAlt },
    // 🔴 プレビューは遷移させない(下のクリックガードが本体)。空文字のままだと href="" になり
    //   「現在のページへの自己リンク」に見えてしまうため、"#" を渡す。
    destinationUrl: input.destinationUrl.trim() !== "" ? input.destinationUrl : "#",
  };
  const view = buildPopupView(doc, popupInput);

  // ① .backdrop 要素は残す(font-family/line-height/colorの継承元)。固定配置・最前面・
  //   暗い背景だけを、popup-view.ts側に用意した専用クラス(.preview-flat)で打ち消す。
  //   🔴 `style.property=` のようなインラインstyleの直接操作はしない——CSPのstyle-src
  //   (unsafe-inline無し)がJSによる個別プロパティ代入も含めて止めるため(実測済み。
  //   SaaS開発ナレッジ「CSPのstyle-srcはReactのinline style属性を実際に止める」と同じ理由)。
  view.backdrop.classList.add("preview-flat");
  // 🔴 host(Shadow DOMの外側・光DOM側の div)自身が、自分を包む
  //   React 側の flex 行の中で shrink-to-fit のままだと、上の `.backdrop.preview-flat`
  //   に書いた `width: 100%` の基準先が依然不確定になる(詳細は popup-view.ts 側のコメント)。
  //   `w-full` は既存の他ファイルでも使っている Tailwind クラスなので新規生成の心配はない。
  view.host.classList.add("w-full");

  // ② クリックしても実際には遷移しない(計測は buildPopupView 自体が一切行わないので、ここでは
  //   ナビゲーションだけを止める)。
  const preventNavigation = (event: Event) => event.preventDefault();
  view.cta?.addEventListener("click", preventNavigation);
  view.imageLink?.addEventListener("click", preventNavigation);

  // ③ 画像URL。未アップロード(下書き・差し替え中)は呼び出し側が渡す blob: URL、
  //   保存済みは配信元のURL。無ければ `src` を付けない(壊れた画像アイコンを出さない)。
  if (view.imageElement && input.imageUrl !== null) {
    view.imageElement.src = input.imageUrl;
  }

  // ④ 保険の2重化: プレビューはクリック・タブ移動・スクリーンリーダーの対象にしない。
  view.host.setAttribute("inert", "");
  view.host.setAttribute("aria-hidden", "true");

  function destroy() {
    view.cta?.removeEventListener("click", preventNavigation);
    view.imageLink?.removeEventListener("click", preventNavigation);
  }

  return { host: view.host, destroy };
}
