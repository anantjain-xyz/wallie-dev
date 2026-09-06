"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { ActionMenu } from "@/components/ui/action-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import { isProviderStatusStale } from "@/features/settings/provider-status-cache";

export interface OpenCodeProviderCredentialStatus {
  providerId: string;
  updatedAt: string;
}

export interface OpenCodeConnectionStatus {
  checkedAt: string;
  connected: boolean;
  providers?: OpenCodeProviderCredentialStatus[];
  updatedAt?: string | null;
}

export function openCodeStatusFromConnection(connection: {
  checkedAt: string;
  connected: boolean;
  providers?: OpenCodeProviderCredentialStatus[];
  updatedAt: string | null;
}): OpenCodeConnectionStatus {
  return {
    checkedAt: connection.checkedAt,
    connected: connection.connected,
    providers: connection.providers ?? [],
    updatedAt: connection.updatedAt,
  };
}

interface OpenCodeConnectionPanelProps {
  initialStatus?: OpenCodeConnectionStatus;
  /** Called whenever the panel learns a new connection status (refresh, save, disconnect). */
  onStatusChange?: (status: OpenCodeConnectionStatus) => void;
}

export function OpenCodeConnectionPanel({
  initialStatus,
  onStatusChange,
}: OpenCodeConnectionPanelProps = {}) {
  const initialStatusRef = useRef(initialStatus);
  const [status, setStatus] = useState<OpenCodeConnectionStatus | null>(
    initialStatus ? { ...initialStatus, providers: initialStatus.providers ?? [] } : null,
  );
  const [credential, setCredential] = useState("");
  const [providerId, setProviderId] = useState("");
  const [providerCredential, setProviderCredential] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pushToast } = useOptionalToast();
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const applyStatus = useCallback((next: OpenCodeConnectionStatus) => {
    const normalized = { ...next, providers: next.providers ?? [] };
    setStatus(normalized);
    onStatusChangeRef.current?.(normalized);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/opencode/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as OpenCodeConnectionStatus;
      applyStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load OpenCode connection status.");
    }
  }, [applyStatus]);

  useEffect(() => {
    if (isProviderStatusStale(initialStatusRef.current?.checkedAt)) void refresh();
  }, [refresh]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/opencode/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const data = (await response.json().catch(() => null)) as
        | (OpenCodeConnectionStatus & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `Save failed (${response.status}).`);
      }
      if (data) applyStatus(data);
      setCredential("");
      setNotice("OpenCode Zen API key saved.");
      pushToast({ priority: "polite", title: "OpenCode Zen API key saved.", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save OpenCode Zen API key.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/opencode/connection", { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Disconnect failed (${response.status}).`);
      }
      setCredential("");
      await refresh();
      setNotice("OpenCode Zen API key removed.");
      pushToast({ priority: "polite", title: "OpenCode Zen API key removed.", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect OpenCode.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedProviderId = providerId.trim();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/opencode/providers/${encodeURIComponent(trimmedProviderId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: providerCredential }),
        },
      );
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        providers?: OpenCodeProviderCredentialStatus[];
      } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `Save failed (${response.status}).`);
      }
      await refresh();
      setProviderId("");
      setProviderCredential("");
      setNotice(`API key saved for ${trimmedProviderId}.`);
      pushToast({
        priority: "polite",
        title: `API key saved for ${trimmedProviderId}.`,
        tone: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save OpenCode provider API key.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnectProvider = async (id: string) => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/opencode/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Disconnect failed (${response.status}).`);
      }
      await refresh();
      setNotice(`API key removed for ${id}.`);
      pushToast({
        priority: "polite",
        title: `API key removed for ${id}.`,
        tone: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove OpenCode provider API key.");
    } finally {
      setIsBusy(false);
    }
  };

  const saveDisabled = isBusy || credential.trim().length === 0;
  const saveProviderDisabled =
    isBusy || providerId.trim().length === 0 || providerCredential.trim().length === 0;
  const providers = status?.providers ?? [];

  return (
    <div className="space-y-6">
      {notice ? <p className="text-[13px] leading-5 text-success">{notice}</p> : null}
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}

      <div className="space-y-4">
        {status === null ? (
          <Status label="Checking connection" value="running" />
        ) : status.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[13px] font-medium text-foreground">OpenCode Zen API key</p>
                <Status compact label="Connected" value="healthy" />
              </div>
              <p className="text-xs text-muted">
                {status.updatedAt ? `Updated ${formatDate(status.updatedAt)}` : "Saved"}
              </p>
            </div>
            <ActionMenu disabled={isBusy} label="OpenCode credential actions">
              <DropdownMenuItem className="text-danger" onSelect={() => void handleDisconnect()}>
                Disconnect
              </DropdownMenuItem>
            </ActionMenu>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Status compact label="Not connected" value="not_started" />
            <p className="text-[13px] text-muted">No OpenCode Zen API key saved yet.</p>
          </div>
        )}

        <form className="space-y-3" onSubmit={handleSave}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">OpenCode Zen API key</span>
            <input
              autoComplete="off"
              className="ui-input font-mono text-[13px]"
              disabled={isBusy}
              onChange={(event) => setCredential(event.target.value)}
              placeholder="sk-…"
              spellCheck={false}
              type="password"
              value={credential}
            />
          </label>

          <div className="flex justify-end">
            <button className="ui-button-primary" disabled={saveDisabled} type="submit">
              <ActionButtonLabel
                idle={status?.connected ? "Update API key" : "Save API key"}
                pending={isBusy}
                pendingLabel="Saving…"
              />
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-foreground">Provider API keys</p>
          <p className="text-xs leading-5 text-muted">
            Models like <span className="font-mono">opencode-go/glm-5.3</span> look up the key under
            that provider id. The reserved <span className="font-mono">opencode</span> prefix uses
            the Zen key above.
          </p>
        </div>

        {providers.length === 0 ? (
          <p className="text-[13px] text-muted">No provider API keys saved yet.</p>
        ) : (
          <ul className="space-y-3">
            {providers.map((provider) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3"
                key={provider.providerId}
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-[13px] font-medium text-foreground">
                      {provider.providerId}
                    </p>
                    <Status compact label="Connected" value="healthy" />
                  </div>
                  <p className="text-xs text-muted">Updated {formatDate(provider.updatedAt)}</p>
                </div>
                <ActionMenu disabled={isBusy} label={`${provider.providerId} credential actions`}>
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() => void handleDisconnectProvider(provider.providerId)}
                  >
                    Disconnect
                  </DropdownMenuItem>
                </ActionMenu>
              </li>
            ))}
          </ul>
        )}

        <form className="space-y-3" onSubmit={handleSaveProvider}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Provider id</span>
            <input
              autoComplete="off"
              className="ui-input font-mono text-[13px]"
              disabled={isBusy}
              onChange={(event) => setProviderId(event.target.value)}
              placeholder="opencode-go"
              spellCheck={false}
              value={providerId}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Provider API key</span>
            <input
              autoComplete="off"
              className="ui-input font-mono text-[13px]"
              disabled={isBusy}
              onChange={(event) => setProviderCredential(event.target.value)}
              placeholder="sk-…"
              spellCheck={false}
              type="password"
              value={providerCredential}
            />
          </label>
          <div className="flex justify-end">
            <button className="ui-button-primary" disabled={saveProviderDisabled} type="submit">
              <ActionButtonLabel idle="Save provider key" pending={isBusy} pendingLabel="Saving…" />
            </button>
          </div>
        </form>
      </div>
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
