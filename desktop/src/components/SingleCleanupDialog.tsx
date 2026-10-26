import { useEffect, useRef } from "react";

import { Icon } from "./Icon";

interface SingleCleanupDialogProps {
  fileName: string;
  relativePath: string;
  pending: boolean;
  resultUnknown: boolean;
  issue: string | null;
  warning?: string | null;
  onCancel(): void;
  onConfirm(): void;
}

export function SingleCleanupDialog({
  fileName,
  relativePath,
  pending,
  resultUnknown,
  issue,
  warning,
  onCancel,
  onConfirm,
}: SingleCleanupDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) cancelRef.current?.focus({ preventScroll: true });
  }, [pending]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!pending) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, pending]);

  return (
    <div
      className="single-cleanup-backdrop"
      onMouseDown={(event) => {
        if (!pending && event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        aria-labelledby="single-cleanup-title"
        aria-describedby={`${warning ? "single-cleanup-path single-cleanup-warning" : "single-cleanup-path"}${resultUnknown ? " single-cleanup-check" : ""}`}
        aria-modal="true"
        className="single-cleanup-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="single-cleanup-dialog__header">
          <span className="single-cleanup-dialog__icon">
            <Icon name="trash" size={17} />
          </span>
          <h2 id="single-cleanup-title">{resultUnknown ? "未能确认清理结果" : "仅回收此文件"}</h2>
        </header>

        <div className="single-cleanup-dialog__file">
          <strong>{fileName}</strong>
          <span id="single-cleanup-path">{relativePath}</span>
        </div>

        {warning ? (
          <div className="single-cleanup-dialog__issue" id="single-cleanup-warning">
            <Icon name="warning" size={16} />
            <span>{warning}</span>
          </div>
        ) : null}

        {issue ? (
          <div className="single-cleanup-dialog__issue" role="alert">
            <Icon name="warning" size={16} />
            <span>{issue}</span>
          </div>
        ) : null}

        {resultUnknown ? (
          <p className="navigation-confirmation-copy" id="single-cleanup-check">
            请先检查文件状态，再决定后续操作。
          </p>
        ) : null}

        <footer className="single-cleanup-dialog__actions">
          <button
            className="button button--ghost"
            disabled={pending}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {resultUnknown ? "返回检查" : "取消"}
          </button>
          {!resultUnknown ? (
            <button
              className="button button--primary button--cleanup"
              disabled={pending}
              onClick={onConfirm}
              type="button"
            >
              <Icon name="trash" size={16} />
              {pending ? "正在处理…" : "移至回收站"}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
