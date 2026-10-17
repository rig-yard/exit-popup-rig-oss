/*
  ローダ(`t.js`)と本体(`exit-popup.js`)をつなぐ**唯一のグローバル**。MIT(このディレクトリのみ)。

  🔴 **`window` に生やすのは、この鍵1つだけ**。
    プロトタイプの拡張も、他の鍵も、1つも足さない。**そのことは検査で固定する。**
  🔴 **本体はローダの持ち物を「写し」で持たない** —— イベントの送信も設定も、
    ローダが `bridge` に置いたものだけを使う。写しを作ると、片方だけ直した日にずれる。
*/

/** ⚠ 埋め込み先の LP に既に在る名前とぶつからない形にする。中身は下の `Bridge`(ローダと本体の受け渡し口)。 */
export const NAMESPACE = "__exitPopupBridge";

/**
 * 旧名(当面維持)。⚠ **読むだけ**で、書くのは `NAMESPACE` だけ(「`window` に生やすのは鍵1つ」は変わらない)。
 * 読む理由: 旧名の時代のローダ(`t.js`)がブラウザのキャッシュに残ったまま、同じ `/embed/adpop.js` で
 * 新しい本体を取りに来ると、旧名の鍵に置かれた注文を本体が見つけられず、何も出なくなるため。
 */
export const LEGACY_NAMESPACE = "__adpopExitPopup";

/*
  ⚠ **配信ホストは書かない。パスだけ。** ホストはローダが自分の `src` から取る(直書きしない方針)。
  🔴 `RUNTIME_PATH` は `scripts/bundle-size.mjs` の `publicOut` と**同じ場所を指していないと、
    本体が 404 になって何も出ない**(しかも fail-closed なので静かに何も起きない)。
    → **写しなので `tests/embed-safety.test.ts` が機械で突き合わせる。**
  ⚠ このモジュールに**副作用のあるものを置かない** —— 検査が「起動させずに定数だけ読む」ために import する。
*/
export const RUNTIME_PATH = "/embed/exit-popup.js";
/** 旧名(当面維持)。⚠ ローダは取りに行かない。すでに貼られたタグ・キャッシュ中の旧ローダのために**配信だけ**続ける。 */
export const LEGACY_RUNTIME_PATH = "/embed/adpop.js";
/** タグに書く属性。**`data-site` より衝突しにくい形**にした。⚠ 管理画面が出すタグ(`src/app/_lib/embedTag.ts`)もこれを読む。 */
export const SITE_ATTRIBUTE = "data-exit-popup-site";

/**
 * 旧名(当面維持)。すでに貼られたタグを壊さないために**読み取りだけ**続ける。
 * 🔴 両方付いているときは、**新名が空でなければ新名が勝つ(空なら旧名)**(`loader.ts` の `siteKeyOf`)。
 */
export const LEGACY_SITE_ATTRIBUTE = "data-adpop-site";

export const CONFIG_PATH = "/api/v1/config";
export const EVENTS_PATH = "/api/v1/events";

export type TriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";

/**
 * 埋め込みが実装しているトリガ。⚠ ここに無い kind はサーバーが返しても**黙って無視する**。
 * ⚠ 管理画面(AGPL 側)も「いま効くトリガ」だけを ON/OFF させるためにこれを読む(向きは server → embed なので可)。
 *   **理由の記録はローダ(`loader.ts` の再輸出の箇所)に置いてある。**
 *
 * 🔴 **②スクロール到達率・④滞在時間 を足してある**。
 *   どちらも `TRIGGER_DEVICES` が `["desktop", "mobile"]` を持つ ——
 *   **これで、いまスマホで使えるきっかけが初めて0件ではなくなる**。
 */
export const IMPLEMENTED_TRIGGERS: readonly TriggerKind[] = ["exit_intent", "scroll", "dwell"];

/**
 * 閾値を持つトリガの、受け付ける範囲(両端含む)。単位は
 *   `scroll` は到達率= %、`dwell` は経過秒。
 * ⚠ 根拠は外部にない(このプロダクトが置いた設計値)。`dwell` の上限1時間(3600秒)は、
 *   「離脱ポップ」という用途を外れる滞在時間を弾くための仮置き。
 * 🔴 **この表を直接読むのは `isValidThreshold`(下)だけにする** —— 管理画面の API(保存時の検査)と
 *   ローダの描画前の検査(2枚目の関門)は、どちらも `isValidThreshold` を経由して読む(範囲だけでなく
 *   「整数であること」の判定も1か所にまとめるため。経緯は `isValidThreshold` のコメント)。
 */
export const TRIGGER_THRESHOLD_RANGE: Readonly<Partial<Record<TriggerKind, { min: number; max: number }>>> = {
  scroll: { min: 1, max: 100 },
  dwell: { min: 1, max: 3600 },
};

/**
 * `threshold` が null のときに使う既定値(README の既定値表と同じ値)。
 * ⚠ **DB 側の既定値(`db/migrations/0005_*.sql` の `kinds` テーブル)とは別の場所に置いた写し**——
 *   DB 側は「行が無いときに作る初期値」、ここは「行はあるが `threshold` が null のときの実行時の既定」。
 *   値は意図して揃えている(`scroll`=50・`dwell`=45)。ずれたら README とこの表のどちらかが古い。
 */
export const DEFAULT_THRESHOLDS: Readonly<Partial<Record<TriggerKind, number>>> = { scroll: 50, dwell: 45 };

/**
 * `threshold` の形が正しいか(kind ごとの範囲・**整数であること**まで含めて判定)。
 * 🔴🔴 **管理画面の保存時の検査(`src/admin/body.ts` の `parseThreshold`)と、ローダの描画前の検査
 *   (`loader.ts` の `resolveThreshold`)が、同じこの1つの関数を読む** —— 以前は
 *   `TRIGGER_THRESHOLD_RANGE` の範囲(min/max)だけを2か所で参照していて、**「整数かどうか」の判定が
 *   サーバー側(`Number.isInteger`)にしか無く、ローダ側は `Math.min(max, Math.max(min, raw))` で
 *   小数も範囲外も境界値へ**丸めて**しまっていた。
 *   → **壊れた `dwell: 0` が「1秒」として動いてしまう**(保存側は拒否したはずの値が、配信経路の
 *   直接改ざん・古い応答・手動のAPI呼び出し等で `popup.triggers` に紛れ込んだときに、埋め込み側だけが
 *   それを「動く値」に救済してしまう=2枚目の関門が1枚目より緩い)。
 * ⚠ **`null` は「既定値を使う」の意味で、どの kind でも常に正しい**。
 *   `threshold` を持たないトリガ(範囲表に無い kind)は、`null` 以外を1つも受け付けない。
 */
export function isValidThreshold(kind: TriggerKind, value: unknown): value is number | null {
  if (value === null) return true;
  const range = TRIGGER_THRESHOLD_RANGE[kind];
  if (range === undefined) return false;
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

export type DeviceKind = "mobile" | "desktop";

/**
 * 端末ごとに使えるきっかけ(実装上の受け皿)。
 * 🔴 **管理画面の案内・トグルの有無と、ローダの登録が、同じこの表を読む**
 *   (`IMPLEMENTED_TRIGGERS` と同じやり方 = 判定を2か所に書いて食い違わせない)。
 * ⚠ **`IMPLEMENTED_TRIGGERS` に無いトリガは、ここに書いてあっても効かない**
 *   (実装そのものがまだ無い)。
 * 🔴 `exit_intent` は PC のみ —— 「画面外への退出」はマウスカーソルの座標が前提で、
 *   タッチ端末には対応する操作が無い。
 */
export const TRIGGER_DEVICES: Record<TriggerKind, readonly DeviceKind[]> = {
  back: ["desktop", "mobile"],
  scroll: ["desktop", "mobile"],
  idle: ["desktop", "mobile"],
  dwell: ["desktop", "mobile"],
  visibility: ["desktop", "mobile"],
  exit_intent: ["desktop"],
};

/**
 * 本体が描く文字数の上限(UTF-16 の長さ)。**これを超えた分は描かれない**(本体が切る)。
 * ⚠ 管理画面の API も同じ値で断る —— 保存できた文字が画面で切れる、を作らないため。
 * 🔴 `imageAlt`(画像の説明)は `headline` と同じ上限にした —— 見出しが無い画像バナーでは
 *   ダイアログの `aria-label` にもなる(同じ役割を担うため、同じ上限で揃える)。
 */
export const TEXT_LIMITS = { headline: 300, body: 600, buttonLabel: 60, imageAlt: 300 } as const;

export type EventKind = "fire" | "suppressed" | "impression" | "click" | "close";

export type CloseReason = "button" | "backdrop" | "esc";

export type VariantContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageKey?: unknown;
  imageAlt?: unknown;
};

/**
 * スマホ用に解決済みの見た目。**サーバーが `same_as_pc` を解決した後の値**——
 * `kind` / `content` のどちらも、PC と同じときはそのまま PC の値の写し。
 */
export type MobileVariantContent = { kind: string; content: VariantContent };

export type Variant = {
  key: string;
  kind: string;
  weight: number;
  content: VariantContent;
  destinationUrl: string;
  /** ⚠ 旧い応答(それより前)には無い。無ければ PC の見た目をそのまま使う(ローダの規則)。 */
  mobile?: MobileVariantContent;
};

/**
 * スマホ用に解決済みの表示設定。**サーバーが `same_as_pc` を解決した後の値**。
 * ⚠ ローダは `same_as_pc` / `custom` を知らない——ここに入っているのは、もう「使ってよい数字」。
 */
export type MobilePopupConfig = {
  minDisplayDelaySeconds: number;
  frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
  triggers: Array<{ kind: TriggerKind; threshold: number | null }>;
};

export type PopupConfig = {
  key: string;
  minDisplayDelaySeconds: number;
  frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
  triggers: Array<{ kind: TriggerKind; threshold: number | null }>;
  variants: Variant[];
  /** ⚠ 旧い応答(それより前)には無い。無ければ PC の値をそのまま使う(ローダの規則)。 */
  mobile?: MobilePopupConfig;
};

export type SiteConfig = { v: number; popup: PopupConfig };

/** 投入エンドポイントへ送る形。⚠ **正は 0003 の `adpop_record_event`**(ここは呼ぶ側の写し)。 */
export type EventPayload = {
  kind: EventKind;
  popupKey: string;
  variantKey?: string;
  triggerKind?: TriggerKind;
  impressionId?: string;
  visitorHash?: string;
  device: "mobile" | "desktop";
  closeReason?: CloseReason;
  pageUrl?: string;
};

/** 本体への注文。**本体は DOM も設定も読み直さない**(読み直すと、読む場所が2つになる)。 */
export type RenderRequest = {
  popupKey: string;
  variant: Variant;
  triggerKind: TriggerKind;
  visitorHash: string;
  device: "mobile" | "desktop";
  pageUrl: string;
  impressionId: string;
  /**
   * 🔴 **画像型の画像 URL を組み立てるための配信ホスト**(ローダが自分の `<script src>` の
   *   origin から読んだもの。コードに直書きしない方針の続き)。
   * ⚠ テキスト型では使わない。**サーバーの応答から来る値ではない**(ローダが自分で読んだタグの `src` の origin)。
   */
  deliveryOrigin?: string;
};

export type Bridge = {
  version: string;
  /** ローダが埋める。本体はこれだけを見る。 */
  request?: RenderRequest;
  /** ローダが持つ送信口。**本体は自分では送らない。** */
  send?: (event: EventPayload) => void;
  /** 本体が読み込み時に埋める。ローダは注文を置いてからこれを呼ぶ(順番が逆でも動く)。 */
  render?: () => void;
  /** 1ページ1回だけ出す。 */
  shown?: boolean;
  /**
   * 🔴 **描画中かどうか**。`startRuntime()` のローカル変数だと、
   *   画像の読み込みを待っている間に本体がもう一度読み込まれたとき(= 2つ目の `startRuntime()`)が
   *   **別の変数**を見てしまい、二重に描いてしまう。**排他は `bridge`(共有物)の側に持たせる**。
   */
  drawing?: boolean;
  /** 表示が確定したときにローダへ知らせる(頻度制御の記録は**ローダが持つ**)。 */
  onShown?: () => void;
};

type GlobalWithBridge = Record<string, unknown>;

export function readBridge(win: unknown): Bridge | undefined {
  const record = win as GlobalWithBridge;
  const value = record[NAMESPACE] ?? record[LEGACY_NAMESPACE];
  return typeof value === "object" && value !== null ? (value as Bridge) : undefined;
}

export function writeBridge(win: unknown, bridge: Bridge): void {
  (win as GlobalWithBridge)[NAMESPACE] = bridge;
}
