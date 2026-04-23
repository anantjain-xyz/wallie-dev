"use client";

import { useCallback, useEffect, useState } from "react";

interface CodexConnectionStatus {
  connected: boolean;
  accountEmail?: string | null;
  expiresAt?: string | null;
}

interface CodexConnectionPanelProps {
  /** Path to return to after the OAuth round trip (defaults to current path). */
  returnTo?: string;
  /** Banner to surface when the query string reports codex_connect=... */
  connectFlash?: string | null;
}

export function CodexConnectionPanel({ returnTo, connectFlash }: CodexConnectionPanelProps) {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/codex/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as CodexConnectionStatus;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Codex connection status.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConnect = () => {
    setIsBusy(true);
    const next = returnTo ?? (typeof window !== "undefined" ? window.location.pathname : "/");
    window.location.href = `/auth/codex?next=${encodeURIComponent(next)}`;
  };

  const handleDisconnect = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/codex/connection", { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Disconnect failed (${response.status}).`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Codex.");
    } finally {
      setIsBusy(false);
    }
  };

  const flashText = codexFlashMessage(connectFlash);

  return (
    <div className="space-y-3">
      <p className="text-sm leading-7 text-muted">
        Codex runs on your personal ChatGPT / Codex account. Sessions you create use the tokens
        stored here; tokens are encrypted at rest and only decrypted inside the agent worker.
      </p>

      {flashText ? <p className="text-sm leading-7 text-muted">{flashText}</p> : null}
      {error ? <p className="text-sm leading-7 text-red-400">{error}</p> : null}

      {status === null ? (
        <p className="text-sm leading-7 text-muted">Checking connection…</p>
      ) : status.connected ? (
        <div className="ui-subpanel flex items-center justify-between gap-3 p-4">
          <div className="text-sm leading-6">
            <div className="font-medium">Connected</div>
            {status.accountEmail ? (
              <div className="text-muted">{status.accountEmail}</div>
            ) : (
              <div className="text-muted">ChatGPT account linked</div>
            )}
          </div>
          <button type="button" className="ui-button" disabled={isBusy} onClick={handleDisconnect}>
            {isBusy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="ui-subpanel flex items-center justify-between gap-3 p-4">
          <div className="text-sm leading-6 text-muted">Not connected</div>
          <button type="button" className="ui-button" disabled={isBusy} onClick={handleConnect}>
            {isBusy ? "Redirecting…" : "Connect Codex"}
          </button>
        </div>
      )}
    </div>
  );
}

function codexFlashMessage(flash: string | null | undefined): string | null {
  if (!flash) return null;
  switch (flash) {
    case "success":
      return "Codex account connected.";
    case "unauthenticated":
      return "Sign in first, then try connecting Codex again.";
    case "state_missing":
    case "state_invalid":
    case "state_mismatch":
      return "Codex sign-in state expired. Please try again.";
    case "token_exchange_failed":
      return "Codex rejected the authorization code. Please try again.";
    case "persist_failed":
      return "Saving Codex credentials failed. Please try again.";
    default:
      return `Codex sign-in error: ${flash}`;
  }
}
