"use client";

import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";

import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  DeleteWorkspaceSecretResponse,
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";

type SecretsSectionProps = {
  canManage: boolean;
  isLoadingSecrets: boolean;
  secrets: WorkspaceSecretPreview[];
  setFlashMessage: (message: FlashMessage) => void;
  setSecrets: Dispatch<SetStateAction<WorkspaceSecretPreview[]>>;
  workspaceId: string;
};

export function WorkspaceSecretsPanel({
  canManage,
  isLoadingSecrets,
  secrets,
  setFlashMessage,
  setSecrets,
  workspaceId,
}: SecretsSectionProps) {
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const otherSecrets = secrets.filter((secret) => secret.key !== "LINEAR_API_KEY");

  const saveSecret = useApiAction<UpsertWorkspaceSecretResponse, [string, string]>({
    call: (key, value) =>
      fetch("/api/secrets", {
        body: JSON.stringify({
          key,
          value,
          workspaceId,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    errorText: "Workspace secret save failed.",
    onSuccess: (payload) => {
      setSecrets((currentSecrets) => upsertSecretPreview(currentSecrets, payload.secret));
      setSecretKey("");
      setSecretValue("");
    },
    setFlashMessage,
    successText: (payload) => `Saved preview for ${payload.secret.key}.`,
  });

  const deleteSecret = useApiAction<DeleteWorkspaceSecretResponse, [string]>({
    call: (key) =>
      fetch(
        `/api/secrets/${encodeURIComponent(key)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "DELETE",
        },
      ),
    errorText: "Workspace secret deletion failed.",
    onSuccess: (payload) => {
      setSecrets((currentSecrets) =>
        currentSecrets.filter((secret) => secret.key !== payload.deletedKey),
      );
    },
    setFlashMessage,
    successText: (payload) => `Deleted ${payload.deletedKey}.`,
  });

  function handleSaveSecret() {
    if (!secretKey.trim() || !secretValue.trim()) {
      setFlashMessage({
        kind: "error",
        text: "Enter both a secret key and a secret value.",
      });
      return;
    }

    void saveSecret.run(secretKey.trim().toUpperCase(), secretValue);
  }

  function handleDeleteSecret(key: string) {
    if (!window.confirm(`Delete ${key}?`)) {
      return;
    }

    void deleteSecret.run(key);
  }

  return canManage ? (
    <div className="space-y-8">
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Secret key</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            className="ui-input"
            name="secretKey"
            onChange={(event) => setSecretKey(event.target.value)}
            placeholder="LINEAR_API_KEY…"
            spellCheck={false}
            value={secretKey}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Secret value</span>
          <textarea
            autoComplete="off"
            className="ui-textarea min-h-28"
            name="secretValue"
            onChange={(event) => setSecretValue(event.target.value)}
            placeholder="Paste the secret value…"
            value={secretValue}
          />
        </label>
        <div className="flex justify-end">
          <button
            className="ui-button-primary"
            disabled={saveSecret.isBusy}
            onClick={handleSaveSecret}
            type="button"
          >
            {saveSecret.isBusy ? "Saving…" : "Save secret"}
          </button>
        </div>
      </div>

      {isLoadingSecrets ? (
        <p className="text-[13px] text-muted">Loading secret previews…</p>
      ) : otherSecrets.length === 0 ? (
        <p className="text-[13px] text-muted">No workspace secrets yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
          {otherSecrets.map((secret) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              key={secret.id}
            >
              <div className="space-y-0.5">
                <p className="text-[13px] font-medium text-foreground">{secret.key}</p>
                <p className="font-mono text-xs text-muted">
                  {secret.valuePreview ?? "preview unavailable"}
                </p>
              </div>
              <button
                className="ui-button-danger"
                disabled={deleteSecret.isBusy}
                onClick={() => void handleDeleteSecret(secret.key)}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : (
    <p className="text-[13px] leading-6 text-muted">
      Workspace admins can manage encrypted secret previews from this surface.
    </p>
  );
}

export function SecretsSection(props: SecretsSectionProps) {
  return (
    <Section
      anchorId="secrets"
      tagline="Secret values never come back to the client. Wallie shows preview-only rows and writes encrypted values through route handlers."
      title="Secrets"
    >
      <WorkspaceSecretsPanel {...props} />
    </Section>
  );
}
