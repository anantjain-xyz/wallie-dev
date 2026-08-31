"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { ActionMenu } from "@/components/ui/action-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import { isProviderStatusStale } from "@/features/settings/provider-status-cache";

export interface OpenCodeConnectionStatus {
  checkedAt: string;
  connected: boolean;
  updatedAt?: string | null;
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
  const [status, setStatus] = useState<OpenCodeConnectionStatus | null>(initialStatus ?? null);
  const [credential, setCredential] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pushToast } = useOptionalToast();
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/opencode/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as OpenCodeConnectionStatus;
      setStatus(data);
      onStatusChangeRef.current?.(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load OpenCode connection status.");
    }
  }, []);

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
      setStatus(data);
      if (data) onStatusChangeRef.current?.(data);
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

  const saveDisabled = isBusy || credential.trim().length === 0;

  return (
    <div className="space-y-4">
      {notice ? <p className="text-[13px] leading-5 text-success">{notice}</p> : null}
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}

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
