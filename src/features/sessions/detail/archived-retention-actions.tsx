"use client";

import { useState, type ReactNode } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { readResponseJson } from "@/features/settings/use-api-action";
import {
  ERASE_RETAINED_CONTENT_CONFIRMATION,
  retainedContentStateSchema,
  type RetainedContentState,
} from "@/lib/run-retention/session-contracts";

export function ArchivedRetentionActions({
  sessionId,
  children,
  initialStatus,
  onErased,
}: {
  sessionId: string;
  children: ReactNode;
  initialStatus: RetainedContentState | undefined;
  onErased?: () => void;
}) {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/retained-content`;
  const [receipt, setReceipt] = useState<RetainedContentState | null>(null);
  const status = receipt ?? initialStatus;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function erase() {
    if (!status?.archivedAt || pending) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedArchivedAt: status.archivedAt,
          confirmation: ERASE_RETAINED_CONTENT_CONFIRMATION,
        }),
      });
      const result = retainedContentStateSchema.safeParse(await readResponseJson(response));
      if (!result.success) throw new Error("Could not read the erasure receipt.");
      setReceipt(result.data);
      setOpen(false);
      onErased?.();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not erase retained session content.",
      );
    } finally {
      setPending(false);
    }
  }

  if (status?.erasedAt) {
    return (
      <span className="text-xs text-muted" role="status">
        Retained content erased
      </span>
    );
  }
  return (
    <>
      {status?.canErase ? (
        <DestructiveConfirmationDialog
          actionLabel="Erase content"
          description="Remove this session’s retained transcript, verification media, and memory it produced. The archive and its provenance will remain visible."
          errorMessage={error}
          onConfirm={() => void erase()}
          onOpenChange={(nextOpen) => {
            if (nextOpen) setError(null);
            setOpen(nextOpen);
          }}
          open={open}
          pending={pending}
          pendingLabel="Erasing…"
          title="Erase retained session content?"
          trigger={
            <button className="ui-button" type="button">
              Erase retained content
            </button>
          }
        />
      ) : null}
      {children}
    </>
  );
}
