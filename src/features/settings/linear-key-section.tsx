"use client";

import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";

import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type { FlashMessage } from "@/features/settings/settings-types";
import {
  dateFormatter,
  interactiveLinkClass,
  Section,
  StatusBadge,
} from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  DeleteWorkspaceSecretResponse,
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";

type LinearKeySectionProps = {
  canManage: boolean;
  isLoadingSecrets: boolean;
  linearSecret: WorkspaceSecretPreview | null;
  setFlashMessage: (message: FlashMessage) => void;
  setSecrets: Dispatch<SetStateAction<WorkspaceSecretPreview[]>>;
  workspaceId: string;
};

export function LinearKeySection({
  canManage,
  isLoadingSecrets,
  linearSecret,
  setFlashMessage,
  setSecrets,
  workspaceId,
}: LinearKeySectionProps) {
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState("");

  const testLinearConnection = useApiAction<{ ok: true }>({
    call: () =>
      fetch(`/api/linear/test-connection?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
      }),
    errorText: "Linear API verification failed.",
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
    onSuccess: (payload) => {
      setSecrets((current) => upsertSecretPreview(current, payload.secret));
      setLinearApiKeyDraft("");
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
    onSuccess: (payload) => {
      setSecrets((current) => current.filter((secret) => secret.key !== payload.deletedKey));
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

  const statusBadge = linearSecret ? (
    <StatusBadge tone="success">Connected</StatusBadge>
  ) : (
    <StatusBadge tone="neutral">Not connected</StatusBadge>
  );

  return (
    <Section
      anchorId="linear"
      statusBadge={statusBadge}
      tagline={
        <>
          Paste a Linear personal API key so Wallie can read issues referenced in sessions. Generate
          one at{" "}
          <a
            className={interactiveLinkClass}
            href="https://linear.app/settings/account/security"
            rel="noreferrer"
            target="_blank"
          >
            linear.app/settings/account/security
          </a>
          .
        </>
      }
      title="Linear"
    >
      {!canManage ? (
        <p className="text-[13px] leading-6 text-muted">
          Workspace admins can manage the Linear API key from this page.
        </p>
      ) : isLoadingSecrets ? (
        <p className="text-[13px] text-muted">Loading Linear API key…</p>
      ) : linearSecret ? (
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
              disabled={testLinearConnection.isBusy}
              onClick={() => void testLinearConnection.run()}
              type="button"
            >
              {testLinearConnection.isBusy ? "Testing…" : "Test connection"}
            </button>
            <button
              className="ui-button-danger"
              disabled={deleteLinearKey.isBusy}
              onClick={handleDeleteLinearKey}
              type="button"
            >
              {deleteLinearKey.isBusy ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      ) : (
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
      )}
    </Section>
  );
}
