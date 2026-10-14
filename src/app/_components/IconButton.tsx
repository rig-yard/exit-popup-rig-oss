/*
  一覧・カードのアイコンのみの操作ボタン。`aria-label` で名前を支援技術に届け、
  ホバー/フォーカスで出るツールチップ(`role="tooltip"`)で見た目でも示す。

  🔴 タップ領域は `TAP_TARGET_44_ICON_ADJACENT`(`TAP_TARGET_44_ICON` ではない)。
  このボタンは常に複数(配信/編集/削除等)が横に並ぶため、`TAP_TARGET_44_ICON` の `-inset-5` を
  そのまま使うと隣のボタンと大きく重なり、押し間違いが起きる(a11y.ts参照)。

  🔴 `tone="danger"`(削除): ふだんは灰色・ホバー/フォーカス時だけ赤(`danger` トークン=
  「取り消せない操作だけに使う」の対象そのもの)。常時赤にしない——操作していないのに常に主張してくる
  赤は違和感の原因になる(常時赤にしない理由)。
*/
import type { ReactNode } from "react";
import { TAP_TARGET_44_ICON_ADJACENT } from "../_lib/a11y";

type IconButtonProps = {
  label: string;
  icon: ReactNode;
  tone?: "default" | "danger";
} & ({ as: "link"; href: string } | { as: "button"; onClick: () => void; disabled?: boolean });

export function IconButton(props: IconButtonProps) {
  const tone = props.tone ?? "default";
  const toneClass =
    tone === "danger"
      ? "text-ink/60 hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger focus-visible:outline-danger"
      : "text-ink/60 hover:bg-paper hover:text-ink focus-visible:outline-ink";
  const className = `flex h-9 w-9 items-center justify-center rounded-lg ${toneClass}
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                     disabled:opacity-40 ${TAP_TARGET_44_ICON_ADJACENT}`;
  return (
    <span className="group/tip relative inline-flex">
      {props.as === "link" ? (
        <a href={props.href} aria-label={props.label} className={className}>
          {props.icon}
        </a>
      ) : (
        <button type="button" aria-label={props.label} disabled={props.disabled} onClick={props.onClick} className={className}>
          {props.icon}
        </button>
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1
                   text-xs font-medium text-paper opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100
                   group-focus-within/tip:opacity-100 motion-reduce:transition-none"
      >
        {props.label}
      </span>
    </span>
  );
}

/** 角丸の四角の枠に、右上から斜めの鉛筆が重なる形(lucide の square-pen 系)。 */
export const EditIcon = (
  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="M10 2.5H4.3a1.7 1.7 0 00-1.7 1.7v11.6a1.7 1.7 0 001.7 1.7h11.6a1.7 1.7 0 001.7-1.7V9.9"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15.3 2.2a1.77 1.77 0 1 1 2.5 2.5L10.1 12.3l-3.3.9.9-3.3 7.6-7.7z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 横3点(ミートボール)。パターンカードの操作メニューのトリガー。 */
export const MeatballIcon = (
  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="4.3" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15.7" cy="10" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

/** チェック(保存の確定。キャンペーン名・WORKSPACE名のインライン編集で使う)。 */
export const CheckIcon = (
  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5 10.5l3.2 3.2L15.5 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** ✕(キャンセル。インライン編集で使う)。 */
export const XIcon = (
  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * ゴミ箱(完全に削除)。
 * 形: ふたの上に台形の取っ手・横長のふた・下がすぼまる台形の本体(中に縦線を入れない)・
 * 太めの線画・角丸(`stroke-linecap`/`stroke-linejoin` とも round)。
 * 🔴 大きさは「約1.5倍(表示30px前後)」。
 *   ボタン本体(`IconButton` は h-9 w-9 のまま=他のアイコンボタンと並びの重さを揃える)に対し、
 *   中の svg だけ既定 `h-7 w-7`(28px。他のアイコンの `h-4 w-4`=16px の1.75倍)にした。
 *   ⚠ Tailwind の標準刻みでは `h-7`(28px)と `h-8`(32px)が「30px」から等距離(両方2px差)。
 *   「1.5倍」(=24px寄り)を優先し、小さい側の `h-7` を選んだ——数値の根拠はこの1行だけなので、
 *   見た目で大きすぎ/小さすぎと感じたら迷わず調整してほしい。
 */
export function TrashIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 6L10.25 3H13.75L15.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 7H20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 7L6.4 20H17.6L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10V18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 10V18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 10V18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
