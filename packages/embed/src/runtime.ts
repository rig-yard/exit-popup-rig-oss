/*
  ADPOP の本体 —— **発火が決まってから取りに行く側**(2段構えの後段)。
  MIT(このディレクトリのみ)。

  🔴 **DOM と CSS を組み立てる部分は `./popup-view` に切り出した**。
    ここに残っているのは: 計測の送信・フォーカスの移動と戻し・Esc / 背景タップ / 閉じるの処理・
    画像の読み込み待ち・`bridge` の排他(「出すかどうか・いつ出すか」の制御)。
    `STYLE`/`FALLBACK_BUTTON_LABEL`/`DIALOG_LABEL` は `popup-view.ts` から**再輸出**してある
    (既存のテスト・`import { STYLE } from "./runtime"` を壊さない)。
  🔴 **画像型の見た目は実寸のモックに合わせてある**。
    ⚠ 見た目の値そのものは `popup-view.ts` にあり、ここからは変えない。

  🔴 **埋め込み先の CSS と混ざらない**:
    ・**Shadow DOM に閉じる**。クラス名の prefix では、埋め込み先の `* { }` や `!important` に負ける
    ・`:host { all: initial }` で、**継承される性質(font / color / line-height)も遮る**
      —— Shadow DOM は子孫セレクタは止めるが、**継承は止めない**
  ⚠ `mode` は **`open`**。`closed` にしても **CSS の隔離は1ミリも変わらない**(隔離は Shadow root が担う)。
    変わるのは「LP の JS から中を読めるか」だけで、**LP の持ち主は元々こちらを貼った人**なので
    そこは守る対象ではない。`open` にしておくと**開発と検査で中を確かめられる**。

  🔴 **任意 HTML を1文字も受け取らない**:
    見出し・本文・ボタン文言は **`textContent` にしか入れない**。`innerHTML` を使わない(`popup-view.ts` 側)。
*/
import { readBridge, type Bridge, type CloseReason, type RenderRequest } from "./bridge";
import { imageUrlOf, isSafeDestination } from "./frequency";
import { buildPopupView, DIALOG_LABEL, FALLBACK_BUTTON_LABEL, STYLE } from "./popup-view";

export const ADPOP_RUNTIME_VERSION = "0.1.0";

// ⚠ 既存の import 元(`./runtime`)を壊さないための再輸出。実体は `popup-view.ts`。
export { DIALOG_LABEL, FALLBACK_BUTTON_LABEL, STYLE };

type Win = Window & typeof globalThis;

function quiet(run: () => void): void {
  try {
    run();
  } catch {
    /* 🔴 LP を1ミリも壊さない */
  }
}

/*
  🔴 **画像の読み込みを待つ上限**。
    8 秒。根拠: 画像の上限は 2MB・GIF は 3MB で、低速回線でも常識的な時間で決着する
    大きさ。離脱の瞬間に出すポップなので早く諦めたいが、**短すぎるとモバイル回線で正しい画像まで
    「出せなかった」ことにしてしまう**(fail-closed の代償は「出ない」なので、閾値を切りすぎない側に倒す)。
    ⚠ 外部根拠は無い(実測に基づかない設計値)。待っている間は何も描かれない(訪問者には「出ないだけ」)ので、
    長めに倒しても実害は「タブが閉じられるまで見えない読み込みが続く」程度。
*/
export const IMAGE_LOAD_TIMEOUT_MS = 8000;

/**
 * 画像の読み込みを待つ。
 * 🔴 **読み込みが成功するまで `src` を付けない呼び出し側と対**: `load` に先に耳を傾けてから `src` を立てる
 *   (キャッシュ即時発火でも取りこぼさない)。失敗(`error`)・上限超過はどちらも reject = **呼び出し側は
 *   「何も描かない」の1本で扱える**(成功と失敗のどちらで止まったかを区別しない)。
 */
function loadImage(win: Win, img: HTMLImageElement, src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      win.clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error("adpop: image load failed or timed out"));
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    const timer = win.setTimeout(() => finish(false), timeoutMs);
    img.src = src;
  });
}

/** 本体が読み込まれたときに1度だけ呼ばれる入口。 */
export function startRuntime(win: Win, doc: Document): boolean {
  const bridge = readBridge(win);
  // 🔴 ローダより先に読まれた / 別の何かが先に居る = 何もしない(fail-closed)
  if (bridge === undefined) return false;

  const render = (): void => {
    quiet(() => {
      if (bridge.shown === true || bridge.drawing === true) return;
      const request = bridge.request;
      if (request === undefined) return;
      if (!isSafeDestination(request.variant?.destinationUrl)) return;
      /*
        🔴🔴 **`shown` を立てるのは `draw()` が**通った後**。
          前は先に立てていたので、**描画が途中で落ちても「表示済み」になっていた** ——
          ローダはそれを見て「出せた」と判断し、**戻るトリガが「戻る」を吸収したままになる**。
          = ポップも出ないのに操作だけ奪う(埋め込み先を壊さない約束を破る)。
        🔴🔴 **`drawing` は `bridge` に持たせる**。
          以前はこの関数のローカル変数だったため、**画像の読み込みを待っている間に本体がもう一度
          読み込まれる**(= `startRuntime()` がもう一度呼ばれる)と、2つ目の呼び出しは**別の
          ローカル変数**(常に `false` から始まる)を見てしまい、再入防止が効かなかった ——
          両方が同じ画像を並行に読み込み、両方成功すると**ポップが2つ・impressionも2件**になる
          (「本体が2回読み込まれても1つ」の約束=多重読み込み耐性に反する)。
          `bridge` は `readBridge(win)` でどの呼び出しからも**同じオブジェクト**が返るので、
          ここに置けば2つ目の `startRuntime()` が作る `render` からも正しく見える。
        ⚠ **失敗したら `shown` は false のまま**なので、ローダ側が「出せなかった」と判定できる。
        🔴 **画像型は `draw()` が画像の読み込みを待つ間 `Promise` のまま**。
          `bridge.drawing` は、その**待っている間ずっと**立てたままにする。`bridge.render` 自体の
          型は同期(`() => void`)なので、ここで `await` はできない —— `.then`/`.catch` で結果を
          受けて `bridge.drawing`/`bridge.shown` を更新する。
      */
      bridge.drawing = true;
      draw(win, doc, bridge, request).then(
        () => {
          bridge.shown = true;
          bridge.drawing = false;
        },
        () => {
          // 🔴 失敗(画像読み込みの失敗・タイムアウト・不正な imageKey 等)。shown は立てない。
          bridge.drawing = false;
        },
      );
    });
  };

  bridge.render = render;
  // ローダが先に注文を置いていたら、そのまま描く
  if (bridge.request !== undefined) render();
  return true;
}

async function draw(win: Win, doc: Document, bridge: Bridge, request: RenderRequest): Promise<void> {
  const send = bridge.send;
  const content = request.variant.content ?? {};
  const isImage = request.variant.kind === "image";

  /*
    🔴 **画像型の2枚目の関門**(「保存時と描画時の両方で検査する」と同じ考え方)。
      配信(`DELIVERABLE_VARIANT`)は「`imageKey` が入っている画像型」だけを配るが、
      **この本体は配信の判定を信用しない** —— ローダを通さずに `bridge.request` を直接
      書き替えられた状態(上の `tests/embed-flow.test.ts` の「2枚目」と同じ経路)でも、
      形が崩れていれば何も描かない。
    ⚠ ここで throw すると `render()` は `bridge.shown` を立てない(=「出せなかった」が伝わる)。
  */
  const imageUrl = isImage ? imageUrlOf(request.deliveryOrigin, content.imageKey) : null;
  if (isImage && imageUrl === null) throw new Error("adpop: invalid image variant");

  // 🔴 DOM と CSS を組み立てるのは popup-view.ts(見た目・動きは変えていない)。
  const view = buildPopupView(doc, { kind: request.variant.kind, content, destinationUrl: request.variant.destinationUrl });
  const { host, shadow, backdrop, closeButton, cta, imageLink, imageElement } = view;

  let closed = false;
  /*
    🔴 **開く前にフォーカスが在った場所を覚えておく**。
      閉じたあと `host.remove()` するだけだと、フォーカスは `body` の先頭へ飛び、
      **キーボードで読んでいた人は位置を失う**。
    ⚠ `document.activeElement` は Shadow root の外側の要素を指す(ポップはまだ挿していない)。
    🔴🔴 **「開く前」は DOM に差し込む直前を指す**。
      画像型は `await loadImage(...)` で最大8秒待つ —— ここで先に読んでしまうと、
      **待っている間に利用者が別の要素へフォーカスを移していても、発火した瞬間の古い要素へ
      戻してしまう**。値を入れるのは下(画像の読み込みを待ったあと・`appendChild` の直前)。
      `close()` は `let` を閉包で捕まえているので、代入する場所を後にずらすだけでよい。
  */
  let previouslyFocused: HTMLElement | null = null;

  /**
   * 🔴 **`aria-modal="true"` を名乗るなら、フォーカスも実際に閉じ込める**
   *   。
   *   宣言だけして Tab が背後の LP へ抜けると、**支援技術には「背後は不活性」と伝えながら
   *   キーボードでは背後を操作できる** = 説明が実装より広い約束になる。
   * ⚠ 閉じ込めるのはこの2つだけ(閉じるボタンと誘導リンク)。
   *   フォーカスできる要素をポップに足したら、ここも足す。
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close("esc");
      return;
    }
    if (event.key !== "Tab") return;
    quiet(() => {
      // ⚠ **閉じ込める要素はここで決める**(フォーカスできる要素を足したら、ここにも足す)。
      const focusable = ([closeButton, imageLink, cta] as (HTMLElement | null)[]).filter(
        (el): el is HTMLElement => el !== null,
      );
      const index = focusable.indexOf(shadow.activeElement as HTMLElement);
      // ⚠ ポップの外に居るなら、まず中へ引き戻す(index が -1 のとき)
      const next = event.shiftKey
        ? focusable[(index <= 0 ? focusable.length : index) - 1]
        : focusable[index < 0 ? 0 : (index + 1) % focusable.length];
      /*
        ⚠ **「`preventDefault` はポップ自身の要素の上でしか呼ばない」の例外。**
          この listener は `document` に付いている(フォーカスがどこに在っても Esc と Tab を拾うため)。
          🔴 ただし **ポップが開いている間だけ**で、閉じたら `removeEventListener` する。
            `aria-modal="true"` を名乗る以上、背後へ Tab で抜けさせないのが**約束の側**。
          ⚠ **Tab と Escape 以外のキーには1つも触らない**(LP のショートカットを止めない)。
      */
      event.preventDefault();
      next.focus();
    });
  };

  function close(reason: CloseReason): void {
    quiet(() => {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKeyDown);
      host.remove();
      // ⚠ 消えた要素にフォーカスが残らないよう、元の場所へ戻す
      quiet(() => previouslyFocused?.focus());
      send?.({
        kind: "close",
        popupKey: request.popupKey,
        variantKey: request.variant.key,
        impressionId: request.impressionId,
        visitorHash: request.visitorHash,
        device: request.device,
        pageUrl: request.pageUrl,
        closeReason: reason,
      });
    });
  }

  closeButton.addEventListener("click", () => close("button"));
  // 背景タップで閉じる(共通の挙動)。⚠ パネルの中のクリックは拾わない
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close("backdrop");
  });

  /*
    ⚠ **`preventDefault` を呼ばない。** 遷移はブラウザに任せ、送信は `sendBeacon` に任せる
      (遷移で中断されない = そのための API)。
    ⚠ 同じ表示で何度押されても**その数だけ**記録する(CTR は畳んで出す)。
    🔴 **画像型は「画像リンク」「ボタン」が別々の `<a>`**(同じ遷移先)。どちらを押しても
      「ポップ内の誘導リンク / ボタンの押下」として同じ `click` イベントを送る(どちらで押したかは分けない)。
  */
  const sendClick = (): void => {
    send?.({
      kind: "click",
      popupKey: request.popupKey,
      variantKey: request.variant.key,
      impressionId: request.impressionId,
      visitorHash: request.visitorHash,
      device: request.device,
      pageUrl: request.pageUrl,
    });
  };
  imageLink?.addEventListener("click", sendClick);
  cta?.addEventListener("click", sendClick);

  /*
    🔴 **画像の読み込みが成功するまで、何も差し込まない**。
      既に設定を取得済みの LP が、差し替え・削除で消えた画像キーを持ったまま exit intent を発火させても、
      `/img/<key>` が 404(または読み込み中にタイムアウト)なら、ここで `loadImage` が reject し、
      `draw()` ごと失敗する(quiet() が外側で握る)。**DOM 挿入・`shown`・impression のどれも成立しない**
      = fail-closed(壊れた画像リンクを訪問者に見せない)。
    ⚠ **既知の限界**(いまは猶予保持を作らない代わり): 差し替え・削除の直後にちょうど発火した訪問者は、
      そのページを再読み込みするまでポップが出ない(README に書く)。
  */
  if (isImage && imageElement !== null) {
    await loadImage(win, imageElement, imageUrl as string, IMAGE_LOAD_TIMEOUT_MS);
  }

  // 🔴 差し込む直前のフォーカス位置(上の注記どおり、待った**あと**に読む)。
  previouslyFocused = doc.activeElement as HTMLElement | null;
  const parent = doc.body ?? doc.documentElement;
  parent.appendChild(host);
  doc.addEventListener("keydown", onKeyDown);
  quiet(() => closeButton.focus());

  /*
    🔴 **表示(impression)の数え方**:
      「Shadow root への挿入完了」+「`requestAnimationFrame` 1フレーム後も
       `document.visibilityState === "visible"`」の**両方**。
    ⚠ **DOM に入れただけ・タブが隠れている間は数えない**(隠れている間に出しても見えないうえ、
      表示として数えると水増しになる)。
    ⚠ 数えなかったときは `bridge.onShown` も呼ばない = **頻度制御の記録も残さない**
      (見えていない表示で7日間の抑制を始めない)。
  */
  const countImpression = (): void => {
    quiet(() => {
      if (closed) return;
      if (doc.visibilityState !== "visible") return;
      send?.({
        kind: "impression",
        popupKey: request.popupKey,
        variantKey: request.variant.key,
        triggerKind: request.triggerKind,
        impressionId: request.impressionId,
        visitorHash: request.visitorHash,
        device: request.device,
        pageUrl: request.pageUrl,
      });
      bridge.onShown?.();
    });
  };
  if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(countImpression);
  else countImpression();
}

/*
  ⚠ 読み込まれたら自分で起動する(ローダが `<script>` を足すだけで動く)。
*/
if (typeof window !== "undefined" && typeof document !== "undefined") {
  quiet(() => startRuntime(window as Win, document));
}
