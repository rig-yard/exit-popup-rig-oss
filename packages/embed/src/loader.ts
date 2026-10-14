/*
  ADPOP のローダ(`t.js`)—— **全訪問者に配る側**。MIT(このディレクトリのみ)。

  やること(2段構え):
    ①タグから サイトキー と配信ホストを読む ②設定を取りに行く ③トリガを仕掛ける
    ④発火したら `fire` を送り、頻度制御を見て ⑤出すと決まってから**本体を取りに行く**
  ⚠ 出ないまま終わる訪問者には、**本体を1バイトも配らない**(2段構えの目的)。

  🔴 **埋め込み先の LP を1ミリも壊さない**。この4つは検査で固定してある:
    ① **描画を止めない** —— `document.write` も同期 XHR も使わない。タグは `async`。
    ② **エラーを外に漏らさない** —— 全部を try/catch で囲み、**失敗したら何もしない**。
    ③ **グローバルを汚さない** —— `window` に生やすのは名前空間1つだけ。
    ④ **配信が落ちても LP は無傷** —— fail-closed(ポップが出ないだけ)。
  ⚠ ②の代償: **こちら側の失敗が誰にも見えない**。管理画面へ届ける仕組みはまだ無い
    (「握り潰して誰も見ない」への対処)。**いまは届いていない**と README に書いた。

  🔴 **実装しているトリガは ⑥exit intent・②スクロール到達率・④滞在時間の3つ**。
    ①戻るは外した(理由は下の IMPLEMENTED_TRIGGERS)。③無操作・⑤タブ切替・①戻るは未実装。
    ⚠ サーバーは**有効なトリガを6種すべて返す**ので、ここは**知らない kind を黙って無視する**
      (= 管理画面で ON にしても未実装の間は何も起きない。README に書いた)。
*/
import {
  CONFIG_PATH,
  DEFAULT_THRESHOLDS,
  EVENTS_PATH,
  IMPLEMENTED_TRIGGERS as IMPLEMENTED_TRIGGERS_FROM_BRIDGE,
  isValidThreshold,
  readBridge,
  RUNTIME_PATH,
  TRIGGER_DEVICES,
  writeBridge,
  type Bridge,
  type EventPayload,
  type MobilePopupConfig,
  type MobileVariantContent,
  type PopupConfig,
  type RenderRequest,
  type SiteConfig,
  type TriggerKind,
  type Variant,
} from "./bridge";
import { isSafeDestination, suppressionReason, type VisitorState } from "./frequency";

export const ADPOP_LOADER_VERSION = "0.1.0";

/** タグに書く属性。**`data-site` より衝突しにくい形**にした。 */
export const SITE_ATTRIBUTE = "data-adpop-site";

/** プレビュー用の強制表示。⚠ **この表示は数値に数えない**。 */
export const PREVIEW_PARAM = "adpop_preview";

/**
 * exit intent(⑥)の「上端」とみなす幅(px)。⚠ **0 ではなく数 px の幅を持たせてある**
 * (本番実測。高速な移動・丸めで `clientY` が0px ちょうどに乗らず抜けることがある)。
 */
const EXIT_INTENT_EDGE_PX = 10;

// ⚠ パスは `./bridge`(副作用の無いモジュール)が持つ —— 検査が起動させずに読めるように。

/**
 * 実装しているトリガ。⚠ ここに無い kind はサーバーが返しても**黙って無視する**。
 *
 * 🔴🔴 **「戻る」は外した**。
 *   理由: **この1機能は、直しても別の経路で重大な欠陥が出続けた**
 *   (最短表示待ち中の吸収 → 出さないと決めた後の吸収 → 描画失敗・同期例外・SPA 遷移)。
 *   🔴 しかも壊れ方が**この製品の唯一の約束を破る向き** ——
 *     「**配信が落ちてもポップが出ないだけ**」。
 *     履歴を触る機能は、失敗すると**他人の LP の操作を奪う**。
 *   → **戻すなら、実ブラウザの検査を土台ごと用意してから戻す。**
 *   ⚠ **設定の型は残してある**(`trigger_kind` の enum・`popup_triggers` の行)。
 *     サーバーは `back` を有効として返しうるが、**ここが無視する**。
 */
// ⚠ 値は副作用の無い `./bridge` が持つ(管理画面の API が起動させずに読めるように)。ここは再輸出。
export const IMPLEMENTED_TRIGGERS: readonly TriggerKind[] = IMPLEMENTED_TRIGGERS_FROM_BRIDGE;

type Win = Window & typeof globalThis;

/** 何があっても外へ投げない(埋め込み先を壊さないための約束の一つ)。 */
function quiet(run: () => void): void {
  try {
    run();
  } catch {
    /* 🔴 ここで握るのが仕事。LP のスクリプトを1つも止めない。 */
  }
}

function hex(length: number, win: Win): string {
  let out = "";
  try {
    const source = win.crypto;
    if (source && typeof source.getRandomValues === "function") {
      const bytes = new Uint8Array(Math.ceil(length / 2));
      source.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] + 0x100).toString(16).slice(1);
      return out.slice(0, length);
    }
  } catch {
    /* 下の fallback へ */
  }
  /*
    ⚠ **暗号的ではない fallback**。ここで作るのは「頻度制御のための匿名ID」だけで、
      秘密でも認証でもない。⚠ 秘密の生成にこの関数を使わない。
  */
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
}

function uuid(win: Win): string {
  try {
    const source = win.crypto as Crypto & { randomUUID?: () => string };
    if (source && typeof source.randomUUID === "function") return source.randomUUID();
  } catch {
    /* 下の fallback へ */
  }
  const h = hex(32, win);
  // v4 の形に整える(値の質は上の fallback と同じ = 暗号的ではない)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 端末を**2値**に落とす(生の User-Agent は使わない・保存しない)。
 *
 * 🔴🔴 **`"ontouchstart" in window` を使わない**(実測で誤りと判明)。
 *   ・jsdom では **true**(Touch Events の IDL 属性を持っている)
 *   ・**デスクトップの Chrome でも true**(ハードウェアに関係なく Touch Events を実装しているため)
 *   → これを touch の判定に使うと、**PC を「スマホ」と数え**、
 *     ⑥exit intent が**PC で1度も登録されない**(= 既定 ON のトリガが黙って死ぬ)。
 *   ⚠ しかも **fail-closed なので誰も気づかない**(ポップが出なくなるだけ)。
 *
 * ✅ 見るのは2つだけ:
 *   ① `(pointer: coarse)` …… 主な入力装置が指かどうか。**これが本命**
 *   ② `navigator.maxTouchPoints` …… `matchMedia` が無い環境の控え。
 *      ⚠ PC の Chrome でも **0** になる(`ontouchstart` と違って**ハードウェアを見る**)
 */
function isTouchDevice(win: Win): boolean {
  try {
    if (typeof win.matchMedia === "function") return win.matchMedia("(pointer: coarse)").matches;
  } catch {
    /* 下の fallback へ */
  }
  try {
    const points = win.navigator?.maxTouchPoints;
    return typeof points === "number" && points > 0;
  } catch {
    return false;
  }
}

function readState(win: Win, key: string): VisitorState | null {
  try {
    const raw = win.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as VisitorState) : null;
  } catch {
    // ⚠ 読めない = 抑制が効かない(既知の限界)。**出しすぎる側**に倒す。
    return null;
  }
}

function writeState(win: Win, key: string, state: VisitorState): void {
  try {
    win.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

function sessionCount(win: Win, key: string): number {
  try {
    const raw = win.sessionStorage.getItem(key);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function bumpSession(win: Win, key: string): void {
  try {
    win.sessionStorage.setItem(key, String(sessionCount(win, key) + 1));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

/**
 * 自分を読み込んだ `<script>` から、**サイトキー**と**配信ホスト**を読む。
 * 🔴 **配信ホストをコードに直書きしない**(ドメインは未取得で、後で変わる)。
 *   → **自分の `src` の origin** を使う。タグを貼り替えれば、それだけで配信先が変わる。
 */
export function readTag(doc: Document): { siteKey: string; deliveryOrigin: string } | null {
  const current = doc.currentScript as HTMLScriptElement | null;
  const script =
    current && current.getAttribute(SITE_ATTRIBUTE)
      ? current
      : (doc.querySelector(`script[${SITE_ATTRIBUTE}]`) as HTMLScriptElement | null);
  if (!script) return null;
  const siteKey = script.getAttribute(SITE_ATTRIBUTE);
  if (!siteKey) return null;
  try {
    // ⚠ `script.src` は解決済みの絶対 URL。取れない(インライン)なら諦める = fail-closed
    const origin = new URL(script.src).origin;
    if (!origin || origin === "null") return null;
    return { siteKey, deliveryOrigin: origin };
  } catch {
    return null;
  }
}

/**
 * `popup.mobile.frequency` の形。🔴 **3つの数値を1つずつ検査する**(以前は
 *   「オブジェクトであること」しか見ておらず、`{}` のような空の値も素通りしていた——
 *   その後 `Number(...) || 0` で無言のまま 0 に丸められ、fail-closed のつもりが
 *   「壊れた値のまま出す」になっていた)。
 */
function isMobileFrequency(value: unknown): value is MobilePopupConfig["frequency"] {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.suppressDays === "number" &&
    typeof v.sessionImpressions === "number" &&
    typeof v.postConversionDays === "number"
  );
}

/** `popup.mobile.triggers` / `popup.triggers` の1要素の形。`threshold` は無い値(null)もありうる。 */
function isMobileTrigger(value: unknown): value is { kind: string; threshold: number | null } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && (typeof v.threshold === "number" || v.threshold === null);
}

/**
 * `popup.mobile` の形。⚠ 無いこと自体は許す(旧い応答)——ここは**在るときの形**だけを見る。
 * 🔴 **`frequency` の中身・`triggers` の要素までちゃんと検査する**(以前は
 *   `typeof frequency === "object"` までしか見ておらず、`{ frequency: {}, triggers: [{}] }` のような
 *   部分的に壊れた応答を「形が合っている」として通してしまっていた——コメントの「fail-closed」の約束が
 *   実装より狭かった)。
 */
function isMobilePopupConfig(value: unknown): value is MobilePopupConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as MobilePopupConfig;
  if (typeof v.minDisplayDelaySeconds !== "number") return false;
  if (!isMobileFrequency(v.frequency)) return false;
  if (!Array.isArray(v.triggers) || !v.triggers.every(isMobileTrigger)) return false;
  return true;
}

/** `variants[].mobile` の形。 */
function isMobileVariantContent(value: unknown): value is MobileVariantContent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as MobileVariantContent;
  return typeof v.kind === "string" && typeof v.content === "object" && v.content !== null;
}

/**
 * 応答が「設定の形」をしているか。⚠ **形が違えば何も出さない**(fail-closed)。
 * 🔴 **`mobile` は在っても無くてもよいが、在るのに形が壊れていたら全体を断る**。
 *   `mobile` が無い応答は旧い応答として扱う(それ以前と同じ動き = PC の値を使う)。
 */
export function readConfig(value: unknown): PopupConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const popup = (value as SiteConfig).popup as PopupConfig | undefined;
  if (typeof popup !== "object" || popup === null) return null;
  if (typeof popup.key !== "string" || popup.key.length === 0) return null;
  if (!Array.isArray(popup.variants) || popup.variants.length === 0) return null;
  if (!Array.isArray(popup.triggers)) return null;
  const frequency = popup.frequency;
  if (typeof frequency !== "object" || frequency === null) return null;
  if (popup.mobile !== undefined && !isMobilePopupConfig(popup.mobile)) return null;
  for (const variant of popup.variants) {
    if (variant?.mobile !== undefined && !isMobileVariantContent(variant.mobile)) return null;
  }
  return popup;
}

/**
 * 端末ごとの表示設定(頻度・最短表示待ち・きっかけ)を選ぶ。
 * 🔴 PC は常に `popup` 自身の値。スマホは `popup.mobile` があればそれを使い、
 *   無ければ PC の値へ落ちる(旧い応答・移行漏れへの後方互換 = ローダの規則)。
 */
export function deviceDisplaySettings(
  popup: PopupConfig,
  device: "mobile" | "desktop",
): Pick<PopupConfig, "minDisplayDelaySeconds" | "frequency" | "triggers"> {
  if (device === "mobile" && popup.mobile !== undefined) return popup.mobile;
  return { minDisplayDelaySeconds: popup.minDisplayDelaySeconds, frequency: popup.frequency, triggers: popup.triggers };
}

/**
 * 端末ごとの見た目(`kind`・`content`)を選ぶ。
 * ⚠ **`destinationUrl` は PC と共通**(デザインではないため)なので、ここでは差し替えない
 *   —— 呼び出し側は選んだバリアントの `destinationUrl` をそのまま使い続ける。
 */
export function deviceVariant(variant: Variant, device: "mobile" | "desktop"): Variant {
  if (device === "mobile" && variant.mobile !== undefined) {
    return { ...variant, kind: variant.mobile.kind, content: variant.mobile.content };
  }
  return variant;
}

/**
 * 出すバリアントを選ぶ。
 * 🔴 **先頭の1つだけ**(A/B の割り当ては未実装)。
 *   ⚠ サーバーは**毎回同じ順**で返すので、同じ訪問者に違うものは出ない。
 *   ⚠ `weight` は返ってきているが、**1ミリも使っていない**。
 */
export function pickVariant(popup: PopupConfig): Variant | null {
  for (const variant of popup.variants) {
    if (isSafeDestination(variant?.destinationUrl)) return variant;
  }
  // 🔴 https でない遷移先しか無いポップは、出さない(描画時の検査)
  return null;
}

/**
 * 保存されている `threshold` を、**描画前にもう一度**検査する(`isSafeDestination` と同じ
 *   「2枚目の関門」——保存側の検査を信用しない)。
 * 🔴🔴 **壊れた値は丸めない。トリガの登録そのものを諦める(fail-closed)**。
 *   以前は範囲外・小数を境界値へ丸めて「動く値」にしていた——`threshold: 0` のような
 *   保存側なら断っていたはずの値が `popup.triggers` に紛れ込んだとき(配信経路の直接改ざん・
 *   古い応答・手動の API 呼び出し等)、**ローダ側だけがそれを「1秒」として動かしてしまう**
 *   = 2枚目の関門が1枚目より緩い。`isValidThreshold`(`bridge.ts`)で kind ごとの範囲・
 *   **整数であること**まで検査し、壊れていれば `null`(使えない)を返す。
 * 🔴🔴 **既定値に使うのは「明示的な `null`」だけ**。
 *   `threshold` キー自体が欠けている(`{ kind: "dwell" }` のような行)は「壊れている」側——
 *   管理 API(`src/admin/body.ts` の `parseThreshold`)は `exactKeys(["threshold"])` で
 *   キー欠落そのものを保存時に拒否している。**ローダだけが「欠落 = null と同じ既定値」に
 *   救済すると、2枚目の関門が1枚目(保存時)より緩くなる**(以前の誤り。`trigger?.threshold`
 *   という読み方が「行が無い」と「行はあるが threshold キーが無い」を区別できていなかった)。
 * @returns 使ってよい秒・%の数値。壊れていて登録そのものを諦めるべきときは `null`。
 */
function resolveThreshold(triggers: PopupConfig["triggers"], kind: TriggerKind): number | null {
  const trigger = triggers.find((t) => t?.kind === kind);
  // ⚠ 行自体が無い、または `threshold` キーが欠落 → 不正(fail-closed)。既定値に落とすのは下の
  //   「キーはあって値が `null`」のときだけ(`in` 演算子で欠落と明示的な null を区別する)。
  if (trigger === undefined || !("threshold" in trigger)) return null;
  const raw = trigger.threshold;
  if (!isValidThreshold(kind, raw)) return null; // 壊れている → 登録を諦める
  return raw === null ? DEFAULT_THRESHOLDS[kind] ?? 0 : raw;
}

type Runtime = {
  win: Win;
  doc: Document;
  siteKey: string;
  deliveryOrigin: string;
  preview: boolean;
  device: "mobile" | "desktop";
  visitorHash: string;
  bridge: Bridge;
};

function pageUrlOf(win: Win): string {
  // 🔴 クエリとフラグメントを**送る前に**落とす(サーバー側でも削る)
  return `${win.location.origin}${win.location.pathname}`;
}

function makeSender(ctx: Runtime): (event: EventPayload) => void {
  const url = `${ctx.deliveryOrigin}${EVENTS_PATH}?site_key=${encodeURIComponent(ctx.siteKey)}`;
  return function send(event: EventPayload): void {
    quiet(() => {
      // 🔴 プレビューの表示は数値に数えない
      if (ctx.preview) return;
      const body = JSON.stringify(event);
      const nav = ctx.win.navigator as Navigator & {
        sendBeacon?: (url: string, data?: BodyInit) => boolean;
      };
      /*
        ⚠ **`text/plain` で送る**。`application/json` にすると preflight(OPTIONS)が要り、
          この API は OPTIONS を実装していない = **イベントが1件も届かなくなる**。
          単純リクエストの範囲に収めるのは、そのため。
      */
      try {
        if (typeof nav.sendBeacon === "function" && typeof ctx.win.Blob === "function") {
          const blob = new ctx.win.Blob([body], { type: "text/plain;charset=UTF-8" });
          if (nav.sendBeacon(url, blob)) return;
        }
      } catch {
        /* fetch へ落とす */
      }
      try {
        void ctx.win
          .fetch(url, {
            method: "POST",
            mode: "cors",
            credentials: "omit",
            keepalive: true,
            headers: { "content-type": "text/plain;charset=UTF-8" },
            body,
          })
          .catch(() => {
            /* 🔴 送れなくても LP は無傷 */
          });
      } catch {
        /* ここで終わり */
      }
    });
  };
}

/** 本体(`adpop.js`)を取りに行く。**発火して、抑制もされなかったときだけ**呼ばれる。 */
/**
 * 本体(`adpop.js`)を取りに行く。**発火して、抑制もされなかったときだけ**呼ばれる。
 *
 * ⚠ **「出せなかった」を呼び出し側へ返す仕組みは、いまは持たない。**
 *   🔴 それが要ったのは**「戻る」トリガ**だけ(出せなかったら `history.back()` で通し直すため)で、
 *     そのトリガは外した。
 *     **使う人が居ない配線を、検査されないまま残さない。**
 *   → **「戻る」を戻すときに、実ブラウザの検査と一緒に作り直す**。
 * ⚠ いま本体が落ちても、起きるのは**ポップが出ないこと**だけ。**LP には何も起きない。**
 */
function loadRuntime(ctx: Runtime, request: RenderRequest): void {
  ctx.bridge.request = request;

  // 既に本体が居るなら、そのまま描かせる(多重読み込み耐性)
  if (typeof ctx.bridge.render === "function") {
    quiet(() => ctx.bridge.render?.());
    return;
  }
  /*
    🔴🔴 **生成と挿入そのものが同期で落ちることがある**。
      代表例は **Trusted Types を要求する CSP** —— `script.src` への代入が例外になる。
      try/catch が無いと `quiet` が外側で握るだけで、**`onGaveUp` に1度も到達しない**
      = **出せていないのに「出せた」ことになり、戻るが吸収されたままになる。**
  */
  /*
    ⚠ **生成と挿入そのものが同期で落ちることがある**(例: Trusted Types を要求する CSP)。
      **握って何もしない** —— 起きるのは「ポップが出ない」だけで、LP は無傷。
  */
  try {
    const script = ctx.doc.createElement("script");
    script.async = true;
    script.src = `${ctx.deliveryOrigin}${RUNTIME_PATH}`;
    // ⚠ 読み込みに失敗しても何もしない(LP は無傷)
    script.onerror = () => {};
    const parent = ctx.doc.body ?? ctx.doc.head ?? ctx.doc.documentElement;
    if (parent === null) return;
    parent.appendChild(script);
  } catch {
    /* 出せないだけ */
  }
}

function arm(ctx: Runtime, popup: PopupConfig): void {
  /*
    🔴 **頻度の抑制を覚える鍵はサイト単位**。
      ⚠ 以前は `popup.key` を含めていた(ポップごと)。表示設定(頻度)がサイト単位になったので、
      鍵もそろえる——揃えないと、稼働中のポップを切り替えた瞬間に「このサイトでは直前に出した」
      記憶が読まれなくなり、直前に見た人にもすぐ新しいポップが出てしまう(画面の「N 日出さない」の
      言葉と動きが食い違う)。
      ⚠ **この変更は、公開済みの LP で既に動いている旧いキー(`adpop:<site>:<popup>`)の記憶を
      1回だけ読み捨てる**(サイト単位の新しい鍵には古い記憶が無いので、全員が1回だけ
      「まだ見ていない」扱いになる)。本番はまだ LP にタグを貼っていないため実害は無い。
  */
  const storageKey = `adpop:${ctx.siteKey}`;
  const armedAt = Date.now();
  /*
    🔴 **端末ごとの表示設定**。判定は起動時に1回だけ(`ctx.device`。loader.ts 冒頭)
      行ったものをそのまま使う——ここで読み直さない(読む場所を2つにしない)。
    ⚠ いまスマホで使えるきっかけは無い(`TRIGGER_DEVICES` で exit_intent が "desktop" だけを
      持つため、結局 `enabled` が空になる)ので、**この分岐自体は現時点で挙動を変えない**。
      先に経路だけ用意する(実装上の受け皿)。
  */
  const settings = deviceDisplaySettings(popup, ctx.device);
  const minDelayMs = Math.max(0, Number(settings.minDisplayDelaySeconds) || 0) * 1000;
  let fired = false;

  const enabled = settings.triggers
    .map((t) => t?.kind)
    .filter((kind): kind is TriggerKind => IMPLEMENTED_TRIGGERS.indexOf(kind as TriggerKind) >= 0)
    // 🔴 管理画面の案内・トグルの有無と、ここが**同じ `TRIGGER_DEVICES` を読む**
    .filter((kind) => TRIGGER_DEVICES[kind].indexOf(ctx.device) >= 0);

  const send = ctx.bridge.send as (event: EventPayload) => void;

  /*
    🔴 **条件を満たしたトリガが決まったら、他のトリガの購読を全部外す**(購読が残っていると後から余計な発火が起きうるため)。
      1ページの表示は最大1回なので、2つ目以降のタイマー・リスナーは
      このあと何が起きても結果に関わらない——残したままだと、
      ①表示後 ②抑制中(頻度制御で suppressed) のどちらでも**裏で動き続け**、
      ページが長く開いたままの LP(動画・読み物)では無意味な `scroll`/`resize` の間引き処理や
      `setTimeout` が積まれたままになる。`fired = true` を立てた**直後**(抑制の判定より前。
      どちらの道でも外したい)に全部呼ぶ。
  */
  const cleanups: Array<() => void> = [];
  function disarmOthers(): void {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      quiet(() => cleanup?.());
    }
  }

  /**
   * トリガの条件が満たされたときに呼ぶ。
   * ⚠ 「出さない」で終わる道が4つある: *抑制された* / *既に出した* / *出せるバリアントが無い* / *早すぎる*。
   *   🔴 どれも **何も起きないだけ**で、埋め込み先には1ミリも影響しない。
   */
  function fire(kind: TriggerKind): void {
    quiet(() => {
      // 🔴 1ページの表示は最大1回。**最初に条件を満たしたトリガだけ**を記録する
      if (fired) return;
      // 🔴 最短表示待ち(既定3秒)。即バウンスに被せない
      if (Date.now() - armedAt < minDelayMs) return;
      fired = true;
      disarmOthers();

      const pageUrl = pageUrlOf(ctx.win);
      const common = {
        popupKey: popup.key,
        visitorHash: ctx.visitorHash,
        device: ctx.device,
        pageUrl,
      };
      // 🔴 発火は**抑制された分も含めて**数える
      send({ ...common, kind: "fire", triggerKind: kind });

      const reason = ctx.preview
        ? null
        : suppressionReason(Date.now(), readState(ctx.win, storageKey), sessionCount(ctx.win, storageKey), {
            suppressDays: Number(settings.frequency.suppressDays) || 0,
            sessionImpressions: Math.max(1, Number(settings.frequency.sessionImpressions) || 1),
            postConversionDays: Number(settings.frequency.postConversionDays) || 0,
          });
      if (reason !== null) {
        // ⚠ 抑制は**表示には数えない**
        send({ ...common, kind: "suppressed", triggerKind: kind });
        return;
      }

      const variant = pickVariant(popup);
      if (variant === null) return;
      // 🔴 選ぶのは PC の content(destinationUrl は端末で共通)。描く見た目だけ端末で差し替える
      const renderedVariant = deviceVariant(variant, ctx.device);

      ctx.bridge.onShown = () => {
        quiet(() => {
          bumpSession(ctx.win, storageKey);
          writeState(ctx.win, storageKey, {
            ...(readState(ctx.win, storageKey) ?? {}),
            lastImpressionAt: Date.now(),
          });
        });
      };
      loadRuntime(ctx, {
        popupKey: popup.key,
        variant: renderedVariant,
        triggerKind: kind,
        visitorHash: ctx.visitorHash,
        device: ctx.device,
        pageUrl,
        impressionId: uuid(ctx.win),
        deliveryOrigin: ctx.deliveryOrigin,
      });
    });
  }

  /*
    ── ① 戻るボタン …… **未実装**───────
    🔴 **このファイルは `history` を1バイトも触らない。**
      `pushState` / `replaceState` / `back` / `forward` / `go` を1度も呼ばない。
      ⚠ **それを検査で固定してある**(`tests/embed-safety.test.ts`)。
        戻すときは、**その検査を外すところから**始まる = 気づかずには戻せない。
  */

  /*
    ── ⑥ exit intent(PC のみ)────────────────────
    🔴 **タッチ端末では登録もしない**(誤爆源を作らない)。
      ⚠ 判定の場所は `enabled` 側にある: `enabled` が `TRIGGER_DEVICES`(bridge.ts)で
        既に端末を見ているので、ここでの `&& ctx.device === "desktop"` は不要になった
        (同じ判定を2か所に書かない。管理画面側も同じ表を読む)。

    🔴 本番実測で `mouseout`(`document`)から切り替えた。
      本番の Chrome で、マウスを速く動かして上へ抜けたとき・DevTools を開いたまま抜けたときに
      一度も発火しなかった(events が)。自動の Chromium で `clientY:0` を送ったときだけ発火した
      = **再現しづらい取りこぼし**だった。

    🔴🔴 `document` への `mouseleave` は
      ブラウザごとに配送が割れる(一次情報): Safari は WebKit が「`mouseenter`/`mouseleave` を
      `Document` へ送るのは誤り」として直している(WebKit bug 120862)。Firefox も `document` では
      動かず `document.documentElement` でのみ動くという報告がある。
      → **主の検知を `document.documentElement` の `mouseleave` に変更**。
      → 元の `mouseout`(`document`・バブリングする)は**控えとして残し**、同じ `fire` を呼ぶ
        (主がどのブラウザかで届かなくても、控えが拾う)。
      ⚠ `fire` 自体に `fired` のラッチがあるので、両方から呼ばれても二重発火はしない
        (このファイル内で検算済み。`arm` 内の `fire` 冒頭 `if (fired) return`)。
      ⚠ 左右の端の上部 `EXIT_INTENT_EDGE_PX` から出た場合も対象に入る。
        誤発火としての実害は小さいと判断し、いまは受け入れる(README に明記)。

    条件は主・控えとも共通: `relatedTarget === null`(子要素間の移動は無視。元の仕様どおり維持)
      かつ `clientY <= EXIT_INTENT_EDGE_PX`(上端の数px の帯。座標の丸め・高速な移動で
      0px ちょうどに乗らない取りこぼしに)。
  */
  if (enabled.indexOf("exit_intent") >= 0) {
    quiet(() => {
      function maybeFire(event: MouseEvent): void {
        // 子要素間の移動(relatedTarget あり)は無視
        if (event.relatedTarget !== null) return;
        if (typeof event.clientY === "number" && event.clientY <= EXIT_INTENT_EDGE_PX) {
          fire("exit_intent");
        }
      }
      // 主: documentElement の mouseleave(非バブリング。Chrome/Edge/Firefox で確認できている経路)
      ctx.doc.documentElement.addEventListener("mouseleave", maybeFire, { passive: true });
      // 控え: document の mouseout(バブリングする。主が届かないブラウザのためのフォールバック)
      // ⚠ passive / 非キャプチャ。preventDefault は1度も呼ばない
      ctx.doc.addEventListener("mouseout", maybeFire, { passive: true });
      cleanups.push(() => {
        ctx.doc.documentElement.removeEventListener("mouseleave", maybeFire);
        ctx.doc.removeEventListener("mouseout", maybeFire);
      });
    });
  }

  /*
    ── ④ 滞在時間(両端末。後の改訂で追加)──────────────────
    🔴 **既定 `threshold` 秒経過したら発火**。待つ時間は `threshold` と**最短表示待ちの大きい方**にする——
      `threshold` が最短表示待ちより短く設定されても、単発のタイマーには「次」が無く、
      `fire()` 自身の最短表示待ちの判定に委ねると、**設定を満たしているのに1度も出ない**
      という取りこぼしになる。
  */
  if (enabled.indexOf("dwell") >= 0) {
    quiet(() => {
      const dwellSeconds = resolveThreshold(settings.triggers, "dwell");
      // 🔴 壊れた threshold(整数でない・範囲外)は登録しない(fail-closed。2枚目の関門)
      if (dwellSeconds === null) return;
      const waitMs = Math.max(dwellSeconds * 1000, minDelayMs);
      const timer = ctx.win.setTimeout(() => fire("dwell"), waitMs);
      cleanups.push(() => ctx.win.clearTimeout(timer));
    });
  }

  /*
    ── ② スクロール到達率(両端末。後の改訂で追加)────────────
    🔴 **最大到達率**で判定する(一度でも超えたら満たしたまま。下に読み戻っても満たさなくならない)。
    🔴 **ページの高さをキャッシュしない** —— 確かめるたびに `scrollHeight` を読み直す
      (遅延読み込み・画像の読み込みで高さが変わる LP でも正しく測るため)。
    🔴 **間引き**: `scroll`/`resize` は `passive` + 1フレームに1回(`requestAnimationFrame`)。
      `requestAnimationFrame` が無い環境では間引かずに直接測る(無いよりは動く側に倒す)。
    ⚠ ページがそもそもスクロールしない(全部が1画面に収まる)ときは測れない——
      「到達率100%」を「表示された瞬間」の発火にはしない(狙いは「読み進んだ」ことの検知)。

    🔴🔴 **最短表示待ちの中で条件を満たし、その後ユーザーが1度もスクロールしなくなったら、
      `scroll` イベントそのものが二度と来ない**(実機の Playwright で見つけた取りこぼし。
      最初は「scroll はスクロールが続く限り再評価されるので自然に直る」と考えていたが、
      これは**最後のスクロールで既に閾値へ到達して読むのをやめた**ケースを見落としていた=誤り)。
      → **条件を満たした瞬間に、最短表示待ちの残り時間だけ1本だけ保険のタイマーを立てる**
        (`dwell` と同じ「残り時間ぶん待って `fire` を呼び直す」対処。到達率は単調に保たれるので、
        タイマーが鳴った時点でまだ条件を満たしている=再計算せず直接 `fire` してよい)。
  */
  if (enabled.indexOf("scroll") >= 0) {
    quiet(() => {
      const resolvedThreshold = resolveThreshold(settings.triggers, "scroll");
      // 🔴 壊れた threshold(整数でない・範囲外)は登録しない(fail-closed。2枚目の関門)
      if (resolvedThreshold === null) return;
      const thresholdPercent: number = resolvedThreshold;
      let scheduled = false;
      let maxReachedPercent = 0;
      let retryTimer: number | null = null;

      function check(): void {
        scheduled = false;
        quiet(() => {
          const root = ctx.doc.documentElement;
          const body = ctx.doc.body;
          const scrollTop = ctx.win.scrollY || root.scrollTop || (body ? body.scrollTop : 0) || 0;
          const viewport = ctx.win.innerHeight || root.clientHeight || 0;
          const full = Math.max(root.scrollHeight || 0, body ? body.scrollHeight : 0);
          if (viewport <= 0 || full <= viewport) return; // スクロールできないページでは測れない
          const reached = ((scrollTop + viewport) / full) * 100;
          if (reached > maxReachedPercent) maxReachedPercent = reached;
          if (maxReachedPercent < thresholdPercent) return;
          const remaining = minDelayMs - (Date.now() - armedAt);
          if (remaining <= 0) {
            fire("scroll");
            return;
          }
          // ⚠ 既に1本積んでいれば十分(到達率は単調なので、早い方が鳴っても遅い方が鳴っても結果は同じ)
          if (retryTimer !== null) return;
          retryTimer = ctx.win.setTimeout(() => {
            retryTimer = null;
            fire("scroll");
          }, remaining);
        });
      }
      function onScrollOrResize(): void {
        if (scheduled) return;
        scheduled = true;
        if (typeof ctx.win.requestAnimationFrame === "function") ctx.win.requestAnimationFrame(check);
        else check();
      }
      // ⚠ passive / 非キャプチャ。preventDefault は1度も呼ばない
      ctx.win.addEventListener("scroll", onScrollOrResize, { passive: true });
      // ⚠ 画面回転・リサイズで「スクロールできる/できない」が変わることがあるため、同じ経路で見る
      ctx.win.addEventListener("resize", onScrollOrResize, { passive: true });
      cleanups.push(() => {
        ctx.win.removeEventListener("scroll", onScrollOrResize);
        ctx.win.removeEventListener("resize", onScrollOrResize);
        if (retryTimer !== null) ctx.win.clearTimeout(retryTimer);
      });
    });
  }
}

/**
 * 起動する。**同じサイトキーで2回貼られても1回しか動かない**(多重読み込み耐性)。
 * @returns 起動したら true。既に居る / タグが読めない / 失敗、なら false
 */
export function startAdpop(win: Win, doc: Document): boolean {
  if (readBridge(win) !== undefined) return false;

  const bridge: Bridge = { version: ADPOP_LOADER_VERSION };
  // 🔴 **最初に置く。** 置く前に何かで失敗すると、2回目の読み込みが素通りする
  writeBridge(win, bridge);

  const tag = readTag(doc);
  if (tag === null) return false;

  let preview = false;
  quiet(() => {
    preview = new URL(win.location.href).searchParams.get(PREVIEW_PARAM) === "1";
  });

  const ctx: Runtime = {
    win,
    doc,
    siteKey: tag.siteKey,
    deliveryOrigin: tag.deliveryOrigin,
    preview,
    device: isTouchDevice(win) ? "mobile" : "desktop",
    visitorHash: "",
    bridge,
  };

  // 匿名ID。⚠ サイトごとに分ける = サイトをまたいで突き合わせない
  const visitorKey = `adpop:visitor:${tag.siteKey}`;
  let stored: string | null = null;
  quiet(() => {
    stored = win.localStorage.getItem(visitorKey);
  });
  ctx.visitorHash = stored !== null && /^[0-9a-f]{32}$/.test(stored) ? stored : hex(32, win);
  if (stored !== ctx.visitorHash) quiet(() => win.localStorage.setItem(visitorKey, ctx.visitorHash));

  bridge.send = makeSender(ctx);

  /*
    ⚠ **ここから先は全部非同期。** LP の描画を1ミリも待たせない。
    ⚠ `fetch` が無い環境(古い端末)では**何もしない** —— polyfill を配らない(重くなる)。
  */
  quiet(() => {
    if (typeof win.fetch !== "function") return;
    const url = `${ctx.deliveryOrigin}${CONFIG_PATH}?site_key=${encodeURIComponent(ctx.siteKey)}`;
    void win
      .fetch(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        // 🔴 fail-closed: 形が読めなければ何もしない
        const popup = readConfig(value);
        if (popup !== null) arm(ctx, popup);
      })
      .catch(() => {
        // 🔴 配信が落ちても LP は無傷(ポップが出ないだけ)
      });
  });
  return true;
}

/*
  ⚠ **読み込まれたら自分で起動する**(タグ1本で動くことが要件)。
    テストは `vi.resetModules()` してから import し、**この行を通した状態**で測る
    (`startAdpop` を手で呼ぶだけだと、自動起動の経路を1度も通らない)。
*/
if (typeof window !== "undefined" && typeof document !== "undefined") {
  quiet(() => startAdpop(window as Win, document));
}
