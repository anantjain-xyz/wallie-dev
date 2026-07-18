"use client";

import { useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter, InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  DeleteWorkspaceSecretResponse,
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";

type LinearKeyControlsProps = {
  allowDelete?: boolean;
  allowReplace?: boolean;
  canManage: boolean;
  isLoadingSecrets?: boolean;
  linearSecret: WorkspaceSecretPreview | null;
  onSecretDeleted?: (deletedKey: string) => Promise<void> | void;
  onSecretSaved?: (secret: WorkspaceSecretPreview) => Promise<void> | void;
  onTestSucceeded?: () => Promise<void> | void;
  workspaceId: string;
};

type LinearKeyFeedbackSlot = "configured" | "initial" | "replace";

export function LinearKeyControls({
  allowDelete = true,
  allowReplace = false,
  canManage,
  isLoadingSecrets = false,
  linearSecret,
  onSecretDeleted,
  onSecretSaved,
  onTestSucceeded,
  workspaceId,
}: LinearKeyControlsProps) {
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState<FlashMessage | null>(null);
  const [feedbackSlot, setFeedbackSlot] = useState<LinearKeyFeedbackSlot>("initial");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const testLinearConnection = useApiAction<{ ok: true }>({
    call: () =>
      fetch(`/api/linear/test-connection?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
      }),
    errorText: "Linear API verification failed.",
    onSuccess: async () => {
      await onTestSucceeded?.();
    },
    setFlashMessage: setFeedbackMessage,
    successText: "Linear API key verified. Wallie can read issues from this workspace.",
  });

  const saveLinearKey = useApiAction<UpsertWorkspaceSecretResponse, [string]>({
    call: (value) =>
      fetch("/api/secrets", {
        body: JSON.stringify({
          key: "LINEAR_API_KEY",
          value,
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    errorText: "Linear API key save failed.",
    onSuccess: async (payload) => {
      setLinearApiKeyDraft("");
      setFeedbackSlot(linearSecret ? "replace" : "configured");
      await onSecretSaved?.(payload.secret);
      await testLinearConnection.run();
    },
    setFlashMessage: setFeedbackMessage,
    successText: null,
  });

  const deleteLinearKey = useApiAction<DeleteWorkspaceSecretResponse, [], boolean>({
    call: () =>
      fetch(
        `/api/secrets/${encodeURIComponent("LINEAR_API_KEY")}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      ),
    errorText: "Linear API key deletion failed.",
    onError: (message) => {
      setDeleteError(message);
      return false;
    },
    onSuccess: async (payload) => {
      setFeedbackSlot("initial");
      await onSecretDeleted?.(payload.deletedKey);
      return true;
    },
    setFlashMessage: (message) => {
      if (message.kind === "success") setFeedbackMessage(message);
    },
    successText: "Linear API key removed.",
  });

  const isSavingLinearKey = saveLinearKey.isBusy || testLinearConnection.isBusy;
  const saveLinearKeyLabel = testLinearConnection.isBusy
    ? "Testing…"
    : saveLinearKey.isBusy
      ? "Saving…"
      : "Save key";

  function handleSaveLinearKey() {
    const value = linearApiKeyDraft.trim();
    const nextSlot = linearSecret ? "replace" : "initial";

    if (!value) {
      setFeedbackSlot(nextSlot);
      setFeedbackMessage({ kind: "error", text: "Paste a Linear API key first." });
      return;
    }

    setFeedbackSlot(nextSlot);
    setFeedbackMessage(null);
    void saveLinearKey.run(value);
  }

  async function handleDeleteLinearKey() {
    setFeedbackSlot("configured");
    setFeedbackMessage(null);
    setDeleteError(null);
    if (await deleteLinearKey.run()) setDeleteOpen(false);
  }

  function handleDraftChange(value: string) {
    setFeedbackMessage(null);
    setLinearApiKeyDraft(value);
  }

  if (!canManage) {
    return (
      <p className="text-[13px] leading-6 text-muted">
        Workspace admins can manage the Linear API key from this page.
      </p>
    );
  }

  if (isLoadingSecrets) {
    return <p className="text-[13px] text-muted">Loading Linear API key…</p>;
  }

  if (linearSecret) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[13px] font-medium text-foreground">Linear API key configured</p>
            <p className="font-mono text-xs text-muted">
              {linearSecret.valuePreview ?? "preview unavailable"} · updated{" "}
              {dateFormatter.format(new Date(linearSecret.updatedAt))}
            </p>
          </div>
          {allowDelete ? (
            <DestructiveConfirmationDialog
              actionLabel="Remove Linear API key"
              description="Removing the Linear API key stops Wallie from reading Linear issues in this workspace until a new key is saved."
              errorMessage={deleteError}
              onConfirm={() => void handleDeleteLinearKey()}
              onOpenChange={(open) => {
                setDeleteOpen(open);
                setDeleteError(null);
              }}
              open={deleteOpen}
              pending={deleteLinearKey.isBusy}
              pendingLabel="Removing…"
              title="Remove Linear API key?"
              trigger={
                <button
                  aria-label="Remove Linear API key"
                  className="ui-button-danger"
                  type="button"
                >
                  Remove
                </button>
              }
            />
          ) : null}
        </div>
        {feedbackSlot === "configured" ? (
          <InlineActionMessage className="sm:ml-auto sm:max-w-md" message={feedbackMessage} />
        ) : null}

        {allowReplace ? (
          <div className="space-y-3 border-t border-border pt-3">
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-foreground">
                Replace Linear API key
              </span>
              <input
                autoComplete="off"
                className="ui-input font-mono"
                name="linearApiKey"
                onChange={(event) => handleDraftChange(event.target.value)}
                placeholder="lin_api_…"
                spellCheck={false}
                type="password"
                value={linearApiKeyDraft}
              />
            </label>
            <div className="space-y-2">
              <div className="flex justify-end">
                <button
                  className="ui-button-primary"
                  disabled={isSavingLinearKey || !linearApiKeyDraft.trim()}
                  onClick={handleSaveLinearKey}
                  type="button"
                >
                  <ActionButtonLabel
                    idle="Save key"
                    pending={isSavingLinearKey}
                    pendingLabel={saveLinearKeyLabel}
                  />
                </button>
              </div>
              {feedbackSlot === "replace" ? (
                <InlineActionMessage className="sm:ml-auto sm:max-w-md" message={feedbackMessage} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium text-foreground">Linear API Key</span>
        <input
          autoComplete="off"
          className="ui-input font-mono"
          name="linearApiKey"
          onChange={(event) => handleDraftChange(event.target.value)}
          placeholder="lin_api_…"
          spellCheck={false}
          type="password"
          value={linearApiKeyDraft}
        />
      </label>
      <div className="space-y-2">
        <div className="flex justify-end">
          <button
            className="ui-button-primary"
            disabled={isSavingLinearKey || !linearApiKeyDraft.trim()}
            onClick={handleSaveLinearKey}
            type="button"
          >
            <ActionButtonLabel
              idle="Save key"
              pending={isSavingLinearKey}
              pendingLabel={saveLinearKeyLabel}
            />
          </button>
        </div>
        {feedbackSlot === "initial" || feedbackSlot === "configured" ? (
          <InlineActionMessage className="sm:ml-auto sm:max-w-md" message={feedbackMessage} />
        ) : null}
      </div>
    </div>
  );
}
