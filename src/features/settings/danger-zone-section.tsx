"use client";

import { useRef, useState } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
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
  workspaceId,
  workspaceName,
}: {
  canDelete: boolean;
  workspaceId: string;
  workspaceName: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmationInputRef = useRef<HTMLInputElement>(null);

  async function deleteWorkspace(confirmation: string) {
    if (busy) return;
    setBusy(true);
    setDialogError(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}`, {
        body: JSON.stringify({ confirmation }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      });
      const payload = await readResponseJson<DeleteWorkspaceResponse>(response);

      // Full navigation: the current route belongs to a workspace that no longer
      // exists, so a hard load drops any stale client state cleanly.
      window.location.assign(payload.redirectTo);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Wallie could not delete this workspace.";
      setDialogError(message);
      setBusy(false);
    }
  }

  async function leaveWorkspace() {
    if (busy) return;
    setBusy(true);
    setDialogError(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/leave`, {
        method: "POST",
      });
      const payload = await readResponseJson<LeaveWorkspaceResponse>(response);

      window.location.assign(payload.redirectTo);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Wallie could not remove you from this workspace.";
      setDialogError(message);
      setBusy(false);
    }
  }

  function handleOpenChange(open: boolean) {
    setDialogOpen(open);
    setDialogError(null);
    if (!open) setConfirmation("");
  }

  const confirmed = confirmation.trim() === workspaceName;

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
              <p className="mt-1 text-xs leading-5 text-muted">
                Permanently delete{" "}
                <span className="font-medium text-foreground">{workspaceName}</span> and all of its
                data. This cannot be undone.
              </p>
            </div>
            <DestructiveConfirmationDialog
              actionDisabled={!confirmed}
              actionLabel="Delete workspace"
              description={
                <>
                  This permanently deletes <strong>{workspaceName}</strong> and everything in it —
                  members, sessions, artifacts, integrations, and secrets. This cannot be undone.
                </>
              }
              errorMessage={dialogError}
              initialFocusRef={confirmationInputRef}
              onConfirm={() => void deleteWorkspace(confirmation)}
              onOpenChange={handleOpenChange}
              open={dialogOpen}
              pending={busy}
              pendingLabel="Deleting…"
              title={`Delete ${workspaceName}?`}
              trigger={
                <button className="ui-button-danger min-h-9 shrink-0" type="button">
                  Delete workspace
                </button>
              }
            >
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-foreground">
                  Type <span className="font-mono">{workspaceName}</span> to confirm
                </span>
                <input
                  ref={confirmationInputRef}
                  autoComplete="off"
                  className="ui-input"
                  disabled={busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  spellCheck={false}
                  value={confirmation}
                />
              </label>
            </DestructiveConfirmationDialog>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-foreground">Leave workspace</h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                Remove yourself from{" "}
                <span className="font-medium text-foreground">{workspaceName}</span>. You lose
                access immediately.
              </p>
            </div>
            <DestructiveConfirmationDialog
              actionLabel="Leave workspace"
              description={
                <>
                  Leaving <strong>{workspaceName}</strong> revokes your access immediately. An admin
                  can re-invite you later.
                </>
              }
              errorMessage={dialogError}
              onConfirm={() => void leaveWorkspace()}
              onOpenChange={handleOpenChange}
              open={dialogOpen}
              pending={busy}
              pendingLabel="Leaving…"
              title={`Leave ${workspaceName}?`}
              trigger={
                <button className="ui-button-danger min-h-9 shrink-0" type="button">
                  Leave workspace
                </button>
              }
            />
          </div>
        )}
      </div>
    </Section>
  );
}
