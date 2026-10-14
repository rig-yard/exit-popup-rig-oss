/*
  ポップ一覧の「配信」列。状態バッジ(旧 StatusChip)+文字ボタンの代わりに、
  トグル1つで配信のオン/オフを切り替える。押した瞬間に呼び出し元が pause/activate を実行する
  (確認ダイアログなし)。失敗時は呼び出し元が `popups` state を更新しないため、`active` の値が
  そのまま元の状態を保つ(楽観的に先に見た目を変えていないので、ロールバック操作が要らない)。

  「稼働中」だけが彩色(signal)。他はグレースケール(シグネチャ配色)。
  色だけに意味を持たせないよう、スイッチの位置に加えて文字ラベルを必ず添える。

  🔴 パターンカードでも同じ部品を再利用する。パターンには「ステータス」が無く
    `archivedAt` の有無だけなので、呼び出し側が `active = archivedAt === null` を渡し、
    文言だけ「配信中/停止中」に変える(`onLabel`/`offLabel`。既定は「稼働中/停止」=ポップ一覧のまま)。
    「アーカイブ」という語は画面に出さない(呼び出し側がトグルのON/OFFとして扱う)。

  🔴 確認: トグルが ON(非アーカイブ)でも実際には配れない状態
    (画像型で画像が無い等)のパターンがある。スイッチの見た目(位置・色)は変えず、横の文言だけを
    `activeLabelOverride` で上書きする(灰色=色だけに意味を持たせない既存の方針のまま。
    説明文は足さない——呼び出し側が短い語に差し替えるだけ)。
*/
import { TAP_TARGET_44_V } from "../_lib/a11y";

export function DeliveryToggle({
  active,
  disabled,
  label,
  onLabel = "稼働中",
  offLabel = "停止",
  activeLabelOverride,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onLabel?: string;
  offLabel?: string;
  /** `active=true` のときだけ文言・色を上書きする(例: ONでも実際には配れない)。灰色固定。 */
  activeLabelOverride?: string;
  onToggle: () => void;
}) {
  const activeText = activeLabelOverride ?? onLabel;
  const activeTextClass = activeLabelOverride ? "text-ink/60" : "text-signal";
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                   motion-reduce:transition-none disabled:opacity-60 ${TAP_TARGET_44_V}
                   ${active ? "bg-signal" : "bg-ink/15"}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-5 w-5 rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none
                     ${active ? "translate-x-[22px]" : "translate-x-0.5"}`}
        />
      </button>
      <span className={`text-xs font-semibold ${active ? activeTextClass : "text-ink/60"}`}>{active ? activeText : offLabel}</span>
    </div>
  );
}
