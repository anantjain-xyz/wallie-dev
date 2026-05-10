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

export function SecretsSection({
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

  return (
    <Section title="Secrets">
      <div className="space-y-4">
        <p className="text-sm leading-7 text-muted">
          Secret values never come back to the client. Wallie shows preview-only rows and writes
          encrypted values through route handlers.
        </p>

        {canManage ? (
          <>
            <div className="ui-subpanel space-y-4 p-4">
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Secret Key</span>
                <input
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="ui-input"
                  name="secretKey"
                  onChange={(event) => setSecretKey(event.target.value)}
                  placeholder="ANTHROPIC_API_KEY…"
                  spellCheck={false}
                  value={secretKey}
                />
              </label>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Secret Value</span>
                <textarea
                  autoComplete="off"
                  className="ui-textarea min-h-28"
                  name="secretValue"
                  onChange={(event) => setSecretValue(event.target.value)}
                  placeholder="Paste the Secret Value…"
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
                  {saveSecret.isBusy ? "Saving…" : "Save Secret"}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {isLoadingSecrets ? (
                <div className="ui-subpanel p-4 text-sm text-muted">Loading Secret Previews…</div>
              ) : otherSecrets.length === 0 ? (
                <div className="ui-subpanel p-4 text-sm text-muted">No workspace secrets yet.</div>
              ) : (
                otherSecrets.map((secret) => (
                  <div
                    className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                    key={secret.id}
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">{secret.key}</p>
                      <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
                        {secret.valuePreview ?? "preview unavailable"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="ui-button-danger"
                        disabled={deleteSecret.isBusy}
                        onClick={() => void handleDeleteSecret(secret.key)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
            Workspace admins can manage encrypted secret previews from this surface.
          </div>
        )}
      </div>
    </Section>
  );
}
