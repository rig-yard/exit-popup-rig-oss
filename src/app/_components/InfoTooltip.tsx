"use client";

/*
  見出し横に置く「i」アイコン。ホバー/フォーカス/タップで短い説明を出す。
  🔴 以前はタップ=フォーカスに依存していたが、iOS Safari は
    `<button>` をタップしてもフォーカスを与えない(キーボード操作のTabでしか`:focus`にならない
    というWebKitの文書化された長年の仕様で、`hover`にも依存しない=真のタッチ操作では開く
    きっかけが無い構造上の欠陥だった)。
    ⚠ 自分で確かめた範囲: 直した版は Playwright の webkit(`hasTouch: true`・390px・
    `isMobile: true`)でタップ開閉・外側タップで閉じる・Escで閉じるのすべてを確認した。
    一方、**直す前の版をこの同じ環境で再現しようとしたところ、タップで実際に開いてしまった**
    (`onMouseEnter` が合成的に発火し、フォーカスではなくhover経由で開いていた——Playwrightの
    webkitはデスクトップ版WebKitにタッチ機能を足したものであり、実機iOS Safariの
    「ボタンはタップでフォーカスもhoverも得ない」という挙動そのものは再現しなかった)。
    つまり**この構造上の欠陥はこの検証環境では再現しない**が、直した理由は実機のWebKitの
    文書化された仕様に基づくものなので、直す理由は変わらない(直した後の版が環境に依らず
    正しく動くことを優先した)。
  🔴 開閉のルール(直した後):
  - 開く: マウスホバー、キーボードフォーカス、**タップ(クリック)**。
  - 閉じる: マウスが離れる/フォーカスが外れる、Escキー、**外側のタップ/クリック**。
  - `onClick` はタップ由来のときだけトグルする(`onPointerDown` で捕まえた
    `event.pointerType` が `"touch"`/`"pen"` かどうかで判定)。マウスのクリックでは何もしない
    (マウスは hover が開閉を担い、クリックは既存の挙動=タップではないので無視する)。
    こうすることで「フォーカスで開いた直後にクリックが閉じる」二重発火は起きない
    (マウスのクリックは `onClick` 側で素通りさせるだけで、トグルしないため)。
  🔴 `aria-describedby` で説明文と関連付ける。説明文は常にDOMに置き、見た目だけ `opacity`/
  `pointer-events` で切り替える(`hidden`/`display:none` にすると、フォーカスしても
  支援技術から読めなくなるため使わない)。
  🔴 タップが主な開閉経路になった以上、
    可視のボタンが `h-5 w-5`(20×20px)のままでは390pxでのタップ領域として小さすぎる。
    他のアイコンボタン(許可ドメインの削除✕等)と同じ `TAP_TARGET_44_ICON`(見た目は変えず、
    透明な擬似要素で当たり判定だけ44×44pxに広げる)を適用する。
*/
import { useEffect, useId, useRef, useState } from "react";
import { TAP_TARGET_44_ICON } from "../_lib/a11y";

export function InfoTooltip({ text }: { text: string }) {
  const tooltipId = useId();
  const containerRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // タップ(クリック)でのトグル専用。hover/focusとは独立に持つ(タッチ端末はhover/focusが
  // 効かないことが多いため)。
  const [tapped, setTapped] = useState(false);
  // Escまたは外側タップで閉じた後、再び開くきっかけ(新しいhover/focus/タップ)が来るまで
  // 開かせない。
  const [dismissed, setDismissed] = useState(false);
  // 直近の pointerdown が指/スタイラスだったか(マウスのクリックと区別する)。
  const isTouchPointerRef = useRef(false);

  const open = (hovered || focused || tapped) && !dismissed;

  // 🔴 タップで開いたときはフォーカスを伴わないことがあるため、`onBlur` に頼れない。
  //   外側を押したら明示的に閉じる(ボタン自身へのタップはこのハンドラの対象外)。
  useEffect(() => {
    if (!open) return;
    function handleOutside(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setTapped(false);
        setDismissed(true);
      }
    }
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="説明"
        aria-expanded={open}
        aria-describedby={tooltipId}
        onPointerDown={(e) => {
          isTouchPointerRef.current = e.pointerType === "touch" || e.pointerType === "pen";
        }}
        onClick={() => {
          // マウスのクリックは hover が開閉を担うので何もしない(二重発火を避ける)。
          if (!isTouchPointerRef.current) return;
          setTapped((prev) => !prev);
          setDismissed(false);
        }}
        onMouseEnter={() => {
          setHovered(true);
          setDismissed(false);
        }}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDismissed(true);
            setTapped(false);
          }
        }}
        className={`flex h-5 w-5 items-center justify-center rounded-full text-ink/50 hover:text-ink
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44_ICON}`}
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 9.2v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="6.6" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute left-0 top-full z-10 mt-1.5 w-max max-w-[220px] rounded-md
                    bg-ink px-2.5 py-1.5 text-xs font-medium text-paper transition-opacity duration-150
                    motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`}
      >
        {text}
      </span>
    </span>
  );
}
