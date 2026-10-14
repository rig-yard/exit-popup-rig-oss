"use client";

/*
  許可ドメインの削除の確認(`tags/page.tsx` 参照)。
  🔴 統計も消える完全削除(`ConfirmDeleteDialog`)とは重さが違う——許可ドメインはいつでも
    追加し直せ、統計も消えない。カウントダウンは付けない。`UnsavedChangesDialog` と同じく
    `Modal`(フォーカストラップ・Escで閉じる・開く前のフォーカス位置への復帰)をそのまま使う。
  🔴 フォーカス: キャンセルは Modal の既定どおり、開く前にフォーカスしていた ✕ へ戻る
    (✕ 自体がまだDOMに残っているため)。削除成功後は呼び出し側(`handleRemoveOrigin`)が
    追加用の入力欄へ明示的にフォーカスを戻す(✕ がDOMから消えるため、既定の復帰先が無い)。
*/
import { useId } from "react";
import { Modal } from "./Modal";

export function ConfirmRemoveOriginDialog({
  origin,
  onCancel,
  onConfirm,
}: {
  origin: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const titleId = useId();
  const descId = useId();

  return (
    <Modal titleId={titleId} descriptionId={descId} onClose={onCancel}>
      <h2 id={titleId} className="mb-3 text-base font-semibold text-ink">
        「{origin}」を削除しますか
      </h2>
      <p id={descId} className="mb-6 text-sm leading-relaxed text-ink/70">
        このドメインではポップが表示されなくなります。
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-lg px-4 text-sm font-medium text-ink/60 hover:bg-paper
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          className="h-10 rounded-lg bg-danger px-4 text-sm font-semibold text-paper hover:bg-danger/90
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
        >
          削除
        </button>
      </div>
    </Modal>
  );
}
