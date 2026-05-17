"use client";

import { useState } from "react";

import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter } from "@/features/settings/settings-ui";
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
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

export function LinearKeyControls({
  allowDelete = true,
  allowReplace = false,
  canManage,
  isLoadingSecrets = false,
  linearSecret,
  onSecretDeleted,
  onSecretSaved,
  onTestSucceeded,
  setFlashMessage,
  workspaceId,
}: LinearKeyControlsProps) {
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState("");

  const testLinearConnection = useApiAction<{ ok: true }>({
    call: () =>
      fetch(`/api/linear/test-connection?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
      }),
    errorText: "Linear API verification failed.",
    onSuccess: async () => {
      await onTestSucceeded?.();
    },
    setFlashMessage,
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
      await onSecretSaved?.(payload.secret);
    },
    setFlashMessage,
    successText: "Linear API key saved.",
  });

  const deleteLinearKey = useApiAction<DeleteWorkspaceSecretResponse>({
    call: () =>
      fetch(
        `/api/secrets/${encodeURIComponent("LINEAR_API_KEY")}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      ),
    errorText: "Linear API key deletion failed.",
    onSuccess: async (payload) => {
      await onSecretDeleted?.(payload.deletedKey);
    },
    setFlashMessage,
    successText: "Linear API key removed.",
  });

  function handleSaveLinearKey() {
    const value = linearApiKeyDraft.trim();

    if (!value) {
      setFlashMessage({ kind: "error", text: "Paste a Linear API key first." });
      return;
    }

    void saveLinearKey.run(value);
  }

  function handleDeleteLinearKey() {
    if (!window.confirm("Remove the Linear API key for this workspace?")) {
      return;
    }

    void deleteLinearKey.run();
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
            <p className="font-mono text-[12px] text-muted">
              {linearSecret.valuePreview ?? "preview unavailable"} · updated{" "}
              {dateFormatter.format(new Date(linearSecret.updatedAt))}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button"
              disabled={testLinearConnection.isBusy || saveLinearKey.isBusy}
              onClick={() => void testLinearConnection.run()}
              type="button"
            >
              {testLinearConnection.isBusy ? "Testing…" : "Test connection"}
            </button>
            {allowDelete ? (
              <button
                className="ui-button-danger"
                disabled={deleteLinearKey.isBusy}
                onClick={handleDeleteLinearKey}
                type="button"
              >
                {deleteLinearKey.isBusy ? "Removing…" : "Remove"}
              </button>
            ) : null}
          </div>
        </div>

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
                onChange={(event) => setLinearApiKeyDraft(event.target.value)}
                placeholder="lin_api_…"
                spellCheck={false}
                type="password"
                value={linearApiKeyDraft}
              />
            </label>
            <div className="flex justify-end">
              <button
                className="ui-button-primary"
                disabled={saveLinearKey.isBusy || !linearApiKeyDraft.trim()}
                onClick={handleSaveLinearKey}
                type="button"
              >
                {saveLinearKey.isBusy ? "Saving…" : "Save key"}
              </button>
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
          onChange={(event) => setLinearApiKeyDraft(event.target.value)}
          placeholder="lin_api_…"
          spellCheck={false}
          type="password"
          value={linearApiKeyDraft}
        />
      </label>
      <div className="flex justify-end">
        <button
          className="ui-button-primary"
          disabled={saveLinearKey.isBusy || !linearApiKeyDraft.trim()}
          onClick={handleSaveLinearKey}
          type="button"
        >
          {saveLinearKey.isBusy ? "Saving…" : "Save key"}
        </button>
      </div>
    </div>
  );
}
