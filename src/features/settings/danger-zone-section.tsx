"use client";

import { useEffect, useId, useState } from "react";

import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";

type DeleteWorkspaceResponse = {
  deleted: boolean;
  redirectTo: string;
};

type LeaveWorkspaceResponse = {
  redirectTo: string;
};

export function DangerZoneSection({
  canDelete,
  setFlashMessage,
  workspaceId,
  workspaceName,
}: {
  canDelete: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
  workspaceName: string;
}) {
  const [dialog, setDialog] = useState<"delete" | "leave" | null>(null);
  const [busy, setBusy] = useState(false);

  async function deleteWorkspace() {
    setBusy(true);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}`, {
        body: JSON.stringify({ confirmation: workspaceName }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      });
      const payload = await readResponseJson<DeleteWorkspaceResponse>(response);

      // Full navigation: the current route belongs to a workspace that no longer
      // exists, so a hard load drops any stale client state cleanly.
      window.location.assign(payload.redirectTo);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not delete this workspace.",
      });
      setBusy(false);
      setDialog(null);
    }
  }

  async function leaveWorkspace() {
    setBusy(true);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/leave`, {
        method: "POST",
      });
      const payload = await readResponseJson<LeaveWorkspaceResponse>(response);

      window.location.assign(payload.redirectTo);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Wallie could not remove you from this workspace.",
      });
      setBusy(false);
      setDialog(null);
    }
  }

  return (
    <Section
      anchorId="danger-zone"
      tagline={
        canDelete
          ? "Deleting a workspace is permanent and removes every session, artifact, integration, and secret it owns."
          : "Leaving a workspace revokes your access immediately. An admin can re-invite you later."
      }
      title="Danger zone"
    >
      <div className="space-y-4 rounded-[10px] border border-danger/30 bg-danger-soft/40 p-5">
        {canDelete ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-foreground">Delete workspace</h3>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Permanently delete{" "}
                <span className="font-medium text-foreground">{workspaceName}</span> and all of its
                data. This cannot be undone.
              </p>
            </div>
            <button
              className="ui-button-danger min-h-9 shrink-0"
              disabled={busy}
              onClick={() => setDialog("delete")}
              type="button"
            >
              Delete workspace
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-foreground">Leave workspace</h3>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Remove yourself from{" "}
                <span className="font-medium text-foreground">{workspaceName}</span>. You lose
                access immediately.
              </p>
            </div>
            <button
              className="ui-button-danger min-h-9 shrink-0"
              disabled={busy}
              onClick={() => setDialog("leave")}
              type="button"
            >
              Leave workspace
            </button>
          </div>
        )}
      </div>

      {dialog === "delete" ? (
        <DeleteWorkspaceDialog
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void deleteWorkspace()}
          workspaceName={workspaceName}
        />
      ) : null}

      {dialog === "leave" ? (
        <LeaveWorkspaceDialog
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void leaveWorkspace()}
          workspaceName={workspaceName}
        />
      ) : null}
    </Section>
  );
}

function DialogShell({
  busy,
  children,
  descriptionId,
  onCancel,
  titleId,
}: {
  busy: boolean;
  children: React.ReactNode;
  descriptionId: string;
  onCancel: () => void;
  titleId: string;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 isolate z-50 flex items-start justify-center overscroll-contain bg-foreground/28 px-4 py-4 backdrop-blur-sm sm:py-10">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-panel-elevated relative z-10 mt-[20vh] w-full max-w-md overflow-y-auto overscroll-contain bg-surface p-5 sm:p-6"
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
}

function DeleteWorkspaceDialog({
  busy,
  onCancel,
  onConfirm,
  workspaceName,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  workspaceName: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const [confirmation, setConfirmation] = useState("");
  const confirmed = confirmation.trim() === workspaceName;

  return (
    <DialogShell busy={busy} descriptionId={descriptionId} onCancel={onCancel} titleId={titleId}>
      <h2 id={titleId} className="text-lg font-semibold tracking-tight text-foreground">
        Delete workspace
      </h2>
      <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
        This permanently deletes{" "}
        <span className="font-medium text-foreground">{workspaceName}</span> and everything in it —
        members, sessions, artifacts, integrations, and secrets. This cannot be undone.
      </p>
      <label className="mt-4 block space-y-1.5" htmlFor={inputId}>
        <span className="text-[13px] font-medium text-foreground">
          Type <span className="font-mono text-foreground">{workspaceName}</span> to confirm
        </span>
        <input
          autoComplete="off"
          className="ui-input"
          disabled={busy}
          id={inputId}
          onChange={(event) => setConfirmation(event.target.value)}
          spellCheck={false}
          value={confirmation}
        />
      </label>
      <div className="mt-6 flex justify-end gap-2">
        <button className="ui-button min-h-9" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="ui-button-danger min-h-9"
          disabled={busy || !confirmed}
          onClick={onConfirm}
          type="button"
        >
          {busy ? "Deleting" : "Delete workspace"}
        </button>
      </div>
    </DialogShell>
  );
}

function LeaveWorkspaceDialog({
  busy,
  onCancel,
  onConfirm,
  workspaceName,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  workspaceName: string;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <DialogShell busy={busy} descriptionId={descriptionId} onCancel={onCancel} titleId={titleId}>
      <h2 id={titleId} className="text-lg font-semibold tracking-tight text-foreground">
        Leave workspace
      </h2>
      <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
        Leave <span className="font-medium text-foreground">{workspaceName}</span>? You lose access
        immediately. An admin can re-invite you later.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button className="ui-button min-h-9" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="ui-button-danger min-h-9"
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          {busy ? "Leaving" : "Leave workspace"}
        </button>
      </div>
    </DialogShell>
  );
}
