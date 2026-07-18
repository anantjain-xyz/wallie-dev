"use client";

import type { ReactNode, RefObject } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type DestructiveConfirmationDialogProps = {
  actionDisabled?: boolean;
  actionLabel: string;
  cancelLabel?: string;
  children?: ReactNode;
  description: ReactNode;
  errorMessage?: string | null;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending: boolean;
  pendingLabel: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  title: ReactNode;
  trigger: ReactNode;
};

export function DestructiveConfirmationDialog({
  actionDisabled = false,
  actionLabel,
  cancelLabel = "Cancel",
  children,
  description,
  errorMessage,
  initialFocusRef,
  onConfirm,
  onOpenChange,
  open,
  pending,
  pendingLabel,
  restoreFocusRef,
  title,
  trigger,
}: DestructiveConfirmationDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent
        aria-busy={pending || undefined}
        className="max-w-md"
        description={description}
        dismissible={!pending}
        onCloseAutoFocus={
          restoreFocusRef
            ? (event) => {
                event.preventDefault();
                restoreFocusRef.current?.focus();
              }
            : undefined
        }
        onOpenAutoFocus={
          initialFocusRef
            ? (event) => {
                event.preventDefault();
                initialFocusRef.current?.focus();
              }
            : undefined
        }
        title={title}
      >
        {children}
        {errorMessage ? (
          <div
            className="mt-4 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <button className="ui-button min-h-9" disabled={pending} type="button">
              {cancelLabel}
            </button>
          </AlertDialogCancel>
          <button
            className="ui-button-danger min-h-9"
            disabled={pending || actionDisabled}
            onClick={onConfirm}
            type="button"
          >
            {pending ? pendingLabel : actionLabel}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
