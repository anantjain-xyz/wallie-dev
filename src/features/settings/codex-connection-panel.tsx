"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { codexCredentialTypeLabel, type CodexCredentialType } from "@/lib/codex/contracts";

interface CodexConnectionStatus {
  connected: boolean;
  accountEmail?: string | null;
  credentialType?: CodexCredentialType | null;
  expired?: boolean;
  expiresAt?: string | null;
  updatedAt?: string | null;
}

interface CodexConnectionPanelProps {
  /** Preserved for callers that already pass a return target for older OAuth flashes. */
  returnTo?: string;
  /** Banner to surface when the query string reports codex_connect=... */
  connectFlash?: string | null;
}

export function CodexConnectionPanel({ connectFlash }: CodexConnectionPanelProps) {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [credentialType, setCredentialType] = useState<CodexCredentialType>("codex_access_token");
  const [credential, setCredential] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/codex/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as CodexConnectionStatus;
      setStatus(data);
      if (data.credentialType) {
        setCredentialType(data.credentialType);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Codex connection status.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/codex/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential,
          credentialType,
          expiresAt:
            credentialType === "codex_access_token" && expiresOn
              ? new Date(`${expiresOn}T23:59:59.000Z`).toISOString()
              : null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | (CodexConnectionStatus & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `Save failed (${response.status}).`);
      }
      setStatus(data);
      setCredential("");
      setNotice("Codex credential saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Codex credential.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/codex/connection", { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Disconnect failed (${response.status}).`);
      }
      setCredential("");
      setExpiresOn("");
      await refresh();
      setNotice("Codex credential removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Codex.");
    } finally {
      setIsBusy(false);
    }
  };

  const flashText = codexFlashMessage(connectFlash);
  const activeCredentialLabel = status?.credentialType
    ? codexCredentialTypeLabel(status.credentialType)
    : null;
  const saveDisabled = isBusy || credential.trim().length === 0;

  return (
    <div className="space-y-4">
      {flashText ? <p className="text-[13px] leading-5 text-muted">{flashText}</p> : null}
      {notice ? <p className="text-[13px] leading-5 text-success">{notice}</p> : null}
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}

      {status === null ? (
        <p className="text-[13px] text-muted">Checking connection...</p>
      ) : status.connected || status.expired ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-[13px] font-medium text-foreground">
              {activeCredentialLabel ?? "Codex credential"}
            </p>
            <p className="text-[12px] text-muted">
              {status.expired && status.expiresAt
                ? `Expired ${formatDate(status.expiresAt)}`
                : status.expiresAt
                  ? `Expires ${formatDate(status.expiresAt)}`
                  : "No expiration saved"}
            </p>
          </div>
          <button
            type="button"
            className="ui-button-danger"
            disabled={isBusy}
            onClick={handleDisconnect}
          >
            {isBusy ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      ) : (
        <p className="text-[13px] text-muted">No Codex credential saved yet.</p>
      )}

      <form className="space-y-3" onSubmit={handleSave}>
        <div className="inline-flex rounded-[6px] border border-border bg-surface p-1">
          {(["codex_access_token", "platform_api_key"] as const).map((type) => (
            <button
              className={`rounded-[5px] px-3 py-1.5 text-[12px] font-medium transition-colors ${
                credentialType === type
                  ? "bg-surface-strong text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
              disabled={isBusy}
              key={type}
              onClick={() => setCredentialType(type)}
              type="button"
            >
              {codexCredentialTypeLabel(type)}
            </button>
          ))}
        </div>

        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-foreground">
            {codexCredentialTypeLabel(credentialType)}
          </span>
          <input
            autoComplete="off"
            className="ui-input font-mono text-[13px]"
            disabled={isBusy}
            onChange={(event) => setCredential(event.target.value)}
            placeholder={credentialType === "platform_api_key" ? "sk-..." : "Paste access token"}
            spellCheck={false}
            type="password"
            value={credential}
          />
        </label>

        {credentialType === "codex_access_token" ? (
          <label className="block max-w-[220px] space-y-1.5">
            <span className="text-[12px] font-medium text-foreground">Expiration date</span>
            <input
              className="ui-input"
              disabled={isBusy}
              onChange={(event) => setExpiresOn(event.target.value)}
              type="date"
              value={expiresOn}
            />
          </label>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] leading-5 text-muted">
            {credentialType === "codex_access_token" ? (
              <a
                className="underline underline-offset-2"
                href="https://developers.openai.com/codex/enterprise/access-tokens"
                rel="noreferrer"
                target="_blank"
              >
                Create a Codex access token
              </a>
            ) : (
              <a
                className="underline underline-offset-2"
                href="https://platform.openai.com/api-keys"
                rel="noreferrer"
                target="_blank"
              >
                Create an OpenAI API key
              </a>
            )}
          </p>
          <button className="ui-button-primary" disabled={saveDisabled} type="submit">
            {isBusy
              ? "Saving..."
              : status?.connected || status?.expired
                ? "Update credential"
                : "Save credential"}
          </button>
        </div>
      </form>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function codexFlashMessage(flash: string | null | undefined): string | null {
  if (!flash) return null;
  switch (flash) {
    case "success":
      return "Codex credential saved.";
    case "unauthenticated":
      return "Sign in first, then try connecting Codex again.";
    case "oauth_unsupported":
      return "Codex OAuth is no longer supported. Paste a Codex access token or OpenAI API key instead.";
    case "state_missing":
    case "state_invalid":
    case "state_mismatch":
    case "token_exchange_failed":
    case "persist_failed":
      return "Codex OAuth is no longer supported. Paste a credential instead.";
    default:
      return `Codex credential error: ${flash}`;
  }
}
