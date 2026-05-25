"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { codexCredentialTypeLabel, type CodexCredentialType } from "@/lib/codex/contracts";
import { formatSentenceCaseLabel } from "@/lib/labels";

export interface CodexConnectionStatus {
  accountEmail?: string | null;
  authCacheLastRefresh?: string | null;
  connected: boolean;
  credentialType?: CodexCredentialType | null;
  expired?: boolean;
  expiresAt?: string | null;
  reconnectReason?: string | null;
  reconnectRequired?: boolean;
  updatedAt?: string | null;
}

interface CodexDeviceFlow {
  error: string | null;
  expiresAt: string;
  flowId: string;
  instructions: string | null;
  status: "starting" | "prompted" | "authenticated" | "canceled" | "error" | "expired";
  userCode: string | null;
  verificationUri: string | null;
}

interface CodexConnectionPanelProps {
  /** Preserved for callers that already pass a return target for older OAuth flashes. */
  returnTo?: string;
  /** Banner to surface when the query string reports codex_connect=... */
  connectFlash?: string | null;
  /** Called whenever the panel learns a new connection status (refresh, save, disconnect). */
  onStatusChange?: (status: CodexConnectionStatus) => void;
}

const CREDENTIAL_TYPES: CodexCredentialType[] = [
  "chatgpt_auth_json",
  "codex_access_token",
  "platform_api_key",
];

export function CodexConnectionPanel({
  connectFlash,
  onStatusChange,
  returnTo,
}: CodexConnectionPanelProps) {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [credentialType, setCredentialType] = useState<CodexCredentialType>("chatgpt_auth_json");
  const [credential, setCredential] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [deviceFlow, setDeviceFlow] = useState<CodexDeviceFlow | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Held in a ref so the panel is robust to callers that pass a fresh callback
  // on every render — otherwise the refresh effect would refire in a loop.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/codex/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as CodexConnectionStatus;
      setStatus(data);
      onStatusChangeRef.current?.(data);
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

  const pollDeviceFlow = useCallback(
    async (flowId: string) => {
      try {
        const response = await fetch(`/auth/callback/codex?flowId=${encodeURIComponent(flowId)}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const data = (await response.json().catch(() => null)) as
          | (CodexDeviceFlow & { connected?: boolean; error?: string })
          | null;
        if (!response.ok) {
          throw new Error(data?.error ?? `Sign-in check failed (${response.status}).`);
        }
        if (data?.connected) {
          setDeviceFlow(null);
          await refresh();
          return;
        }
        if (data) setDeviceFlow(data);
        if (data?.status === "error" || data?.status === "expired") {
          setError(data.error ?? "Codex sign-in did not complete.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to check Codex sign-in.");
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!deviceFlow) return;
    if (!["starting", "prompted"].includes(deviceFlow.status)) return;

    const timer = window.setInterval(() => {
      void pollDeviceFlow(deviceFlow.flowId);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [deviceFlow, pollDeviceFlow]);

  const handleStartChatGptSignIn = async () => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    setDeviceFlow(null);
    try {
      const next =
        returnTo ??
        (typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "");
      const response = await fetch(`/auth/codex?next=${encodeURIComponent(next)}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json().catch(() => null)) as
        | (CodexDeviceFlow & { error?: string })
        | null;
      if (!response.ok || !data) {
        throw new Error(data?.error ?? `Sign-in start failed (${response.status}).`);
      }
      if (data.status === "error") {
        throw new Error(data.error ?? "Codex sign-in could not start.");
      }
      if (data.status === "authenticated") {
        await pollDeviceFlow(data.flowId);
        return;
      }
      setDeviceFlow(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Codex sign-in.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleCancelChatGptSignIn = async () => {
    if (!deviceFlow) return;
    setIsBusy(true);
    setError(null);
    try {
      await fetch(`/auth/callback/codex?flowId=${encodeURIComponent(deviceFlow.flowId)}`, {
        method: "DELETE",
      });
      setDeviceFlow(null);
      setNotice("Codex sign-in canceled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel Codex sign-in.");
    } finally {
      setIsBusy(false);
    }
  };

  const cancelDeviceFlowQuietly = useCallback(async (flowId: string) => {
    try {
      await fetch(`/auth/callback/codex?flowId=${encodeURIComponent(flowId)}`, {
        method: "DELETE",
      });
    } catch {
      // Leaving ChatGPT mode should stop local polling even if backend cleanup fails.
    }
  }, []);

  const handleCredentialTypeChange = (type: CodexCredentialType) => {
    if (type !== "chatgpt_auth_json" && deviceFlow) {
      const flowId = deviceFlow.flowId;
      setDeviceFlow(null);
      void cancelDeviceFlowQuietly(flowId);
    }
    setCredentialType(type);
    setError(null);
    setNotice(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (credentialType === "chatgpt_auth_json") return;

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
      if (data) onStatusChangeRef.current?.(data);
      setCredential("");
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
      setDeviceFlow(null);
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

  const connectionTone: "connected" | "expired" | "reconnect" | null = status
    ? status.reconnectRequired
      ? "reconnect"
      : status.expired
        ? "expired"
        : status.connected
          ? "connected"
          : null
    : null;
  const showForm = !status?.connected;

  return (
    <div className="space-y-4">
      {flashText ? <p className="text-[13px] leading-5 text-muted">{flashText}</p> : null}
      {notice ? <p className="text-[13px] leading-5 text-success">{notice}</p> : null}
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}

      {status === null ? <p className="text-[13px] text-muted">Checking connection...</p> : null}

      {status && connectionTone ? (
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-[13px]">
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${dotClass(connectionTone)}`}
            />
            <span className="truncate font-medium text-foreground">
              {activeCredentialLabel ?? "Codex credential"}
            </span>
            <span className="text-muted">·</span>
            <span className="truncate text-muted">{statusSecondary(status)}</span>
          </p>
          <button
            type="button"
            className="text-[12px] text-muted underline-offset-2 transition-colors hover:text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isBusy}
            onClick={handleDisconnect}
          >
            {isBusy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : null}

      {status && showForm ? (
        <>
          <div className="inline-flex flex-wrap rounded-[6px] border border-border bg-surface p-1">
            {CREDENTIAL_TYPES.map((type) => (
              <button
                className={`rounded-[5px] px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  credentialType === type
                    ? "bg-surface-strong text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
                disabled={isBusy}
                key={type}
                onClick={() => handleCredentialTypeChange(type)}
                type="button"
              >
                {codexCredentialTypeLabel(type)}
              </button>
            ))}
          </div>

          {credentialType === "chatgpt_auth_json" ? (
            <div className="space-y-3">
              <button
                className="ui-button-primary"
                disabled={
                  isBusy || deviceFlow?.status === "starting" || deviceFlow?.status === "prompted"
                }
                onClick={handleStartChatGptSignIn}
                type="button"
              >
                {isBusy ? "Starting..." : "Sign in with ChatGPT"}
              </button>

              {deviceFlow ? (
                <div className="space-y-2 rounded-[6px] border border-border bg-surface p-3">
                  <p className="text-[12px] font-medium text-foreground">
                    {deviceFlow.status === "starting"
                      ? "Waiting for sign-in code..."
                      : deviceFlow.status === "prompted"
                        ? deviceFlow.userCode
                          ? "Enter this code in ChatGPT"
                          : "Waiting for sign-in code..."
                        : formatSentenceCaseLabel(deviceFlow.status)}
                  </p>
                  {deviceFlow.userCode ? (
                    <p className="font-mono text-[22px] font-semibold tracking-normal text-foreground">
                      {deviceFlow.userCode}
                    </p>
                  ) : null}
                  {deviceFlow.verificationUri ? (
                    <a
                      className="text-[12px] text-link underline underline-offset-2"
                      href={deviceFlow.verificationUri}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open ChatGPT sign-in
                    </a>
                  ) : null}
                  <div>
                    <button
                      className="text-[12px] font-medium text-danger underline-offset-2 transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isBusy}
                      onClick={handleCancelChatGptSignIn}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <form className="space-y-3" onSubmit={handleSave}>
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-foreground">
                  {codexCredentialTypeLabel(credentialType)}
                </span>
                <input
                  autoComplete="off"
                  className="ui-input font-mono text-[13px]"
                  disabled={isBusy}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={
                    credentialType === "platform_api_key" ? "sk-..." : "Paste access token"
                  }
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
                    : status?.expired || status?.reconnectRequired
                      ? "Update credential"
                      : "Save credential"}
                </button>
              </div>
            </form>
          )}
        </>
      ) : null}
    </div>
  );
}

function dotClass(tone: "connected" | "expired" | "reconnect"): string {
  switch (tone) {
    case "connected":
      return "bg-accent";
    case "expired":
      return "bg-danger";
    case "reconnect":
      return "bg-warning";
  }
}

function statusSecondary(status: CodexConnectionStatus): string {
  if (status.reconnectRequired) {
    return status.reconnectReason ?? "Reconnect required";
  }
  if (status.expired) {
    return status.expiresAt ? `Expired ${formatDate(status.expiresAt)}` : "Expired";
  }
  switch (status.credentialType) {
    case "codex_access_token":
      if (status.expiresAt) return `Expires ${formatDate(status.expiresAt)}`;
      break;
    case "chatgpt_auth_json":
      if (status.accountEmail) return `Signed in as ${status.accountEmail}`;
      break;
    case "platform_api_key":
    default:
      break;
  }
  return status.updatedAt ? `Connected ${formatDate(status.updatedAt)}` : "Connected";
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
    case "chatgpt_device_required":
      return "Start ChatGPT subscription sign-in from this panel.";
    case "pending":
      return "Codex sign-in is still pending.";
    case "oauth_unsupported":
      return "Use ChatGPT subscription sign-in, a Codex access token, or an OpenAI API key.";
    case "state_missing":
    case "state_invalid":
    case "state_mismatch":
    case "token_exchange_failed":
    case "persist_failed":
      return "Codex sign-in could not be completed. Try connecting again.";
    default:
      return `Codex credential error: ${flash}`;
  }
}
