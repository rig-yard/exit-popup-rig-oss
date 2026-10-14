"use client";

/*
  パターンカードの「…」メニュー。中身は「編集」「削除」(削除は赤文字)。
  開閉・外側クリック・Esc の挙動は `SiteSwitcher.tsx` と同じ形(このリポジトリの既存の作法)。
  🔴 `role="menu"`/`role="menuitem"` を名乗る以上、矢印キーでの移動(ARIA Authoring Practices)
    まで実装する——名乗るだけで動きを付けないと、スクリーンリーダー利用者には「メニューなのに
    矢印が効かない」という壊れた挙動に見える。

  🔴 ① 保存・キャンセルで表示モードへ戻ったとき・削除の確認をキャンセルしたとき、フォーカスが
      この「…」ボタンへ戻らず body に落ちていた。原因は、メニュー項目を押した時点でメニュー自体が
      閉じて項目(ボタン)がDOMから消え、その後に開く Modal/ConfirmDeleteDialog の
      `useFocusTrap` が「開く直前に focus されていた要素」を記録する仕組み(`previouslyFocused`)
      が、その消えた項目ではなく既に body を指してしまっていたため。`useFocusTrap` 自体を直さず、
      呼び出し側(VariantCard)がこの「…」ボタンへ明示的に `.focus()` できるよう、
      `forwardRef` + `useImperativeHandle` で `focus()` を公開する。
    ② 編集中は「編集」を出さない(すでに編集中のカードへ「編集」を出す意味が無い。無駄なものは
      出さないという既存の方針どおり)。
*/
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { MeatballIcon } from "./IconButton";
import { TAP_TARGET_44_ICON_ADJACENT } from "../_lib/a11y";

export type PatternMenuHandle = { focus: () => void };

export const PatternMenu = forwardRef<
  PatternMenuHandle,
  {
    label: string;
    disabled?: boolean;
    /** 編集中のカードでは「編集」を出さない(すでに編集中なので無駄)。 */
    hideEdit?: boolean;
    onEdit: () => void;
    onDelete: () => void;
  }
>(function PatternMenu({ label, disabled = false, hideEdit = false, onEdit, onDelete }, ref) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => triggerRef.current?.focus() }), []);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // 開いたら最初の項目へフォーカス。Esc で閉じてトリガーへ戻す(SiteSwitcherと同じ形)。
  // Tab は既定の移動を許したうえでメニューを閉じる(APGの「メニューの外へ出たら閉じる」)。
  // ArrowUp/ArrowDownは項目間を循環させる。
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
      if (!items || items.length === 0) return;
      event.preventDefault();
      const currentIndex = Array.from(items).indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        event.key === "ArrowDown" ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg text-ink/60 hover:bg-paper hover:text-ink
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                   disabled:opacity-40 ${TAP_TARGET_44_ICON_ADJACENT}`}
      >
        {MeatballIcon}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {!hideEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm font-medium text-ink hover:bg-paper
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              編集
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm font-medium text-danger hover:bg-danger-soft
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
          >
            削除
          </button>
        </div>
      )}
    </div>
  );
});
