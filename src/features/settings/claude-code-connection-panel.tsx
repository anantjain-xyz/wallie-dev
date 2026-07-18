"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/shared/spinner";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { ActionMenu } from "@/components/ui/action-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";

export interface ClaudeCodeConnectionStatus {
  connected: boolean;
  updatedAt?: string | null;
}

interface ClaudeCodeConnectionPanelProps {
  /** Called whenever the panel learns a new connection status (refresh, save, disconnect). */
  onStatusChange?: (status: ClaudeCodeConnectionStatus) => void;
}

export function ClaudeCodeConnectionPanel({ onStatusChange }: ClaudeCodeConnectionPanelProps = {}) {
  const [status, setStatus] = useState<ClaudeCodeConnectionStatus | null>(null);
  const [credential, setCredential] = useState("");
  const [pendingAction, setPendingAction] = useState<"disconnect" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);
  const { pushToast } = useOptionalToast();
  const isBusy = pendingAction !== null;

  // Held in a ref so the panel is robust to callers that pass a fresh callback
  // on every render — otherwise the refresh effect would refire in a loop.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/claude-code/connection", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status check failed (${response.status}).`);
      }
      const data = (await response.json()) as ClaudeCodeConnectionStatus;
      setStatus(data);
      onStatusChangeRef.current?.(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load Claude Code connection status.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setPendingAction("save");
    setError(null);
    try {
      const response = await fetch("/api/claude-code/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const data = (await response.json().catch(() => null)) as
        | (ClaudeCodeConnectionStatus & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `Save failed (${response.status}).`);
      }
      setStatus(data);
      if (data) onStatusChangeRef.current?.(data);
      setCredential("");
      pushToast({ priority: "polite", title: "Anthropic API key saved.", tone: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save Anthropic API key.";
      setError(message);
      pushToast({ priority: "assertive", title: message, tone: "danger" });
    } finally {
      actionInFlightRef.current = false;
      setPendingAction(null);
    }
  };

  const handleDisconnect = async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setPendingAction("disconnect");
    setError(null);
    try {
      const response = await fetch("/api/claude-code/connection", { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Disconnect failed (${response.status}).`);
      }
      setCredential("");
      await refresh();
      pushToast({ priority: "polite", title: "Anthropic API key removed.", tone: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect Claude Code.";
      setError(message);
      pushToast({ priority: "assertive", title: message, tone: "danger" });
    } finally {
      actionInFlightRef.current = false;
      setPendingAction(null);
    }
  };

  const saveDisabled = isBusy || credential.trim().length === 0;

  return (
    <div className="space-y-4">
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}

      {status === null ? (
        <Status label="Checking connection" value="running" />
      ) : status.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-foreground">Anthropic API key</p>
              <Status compact label="Connected" value="healthy" />
            </div>
            <p className="text-xs text-muted">
              {status.updatedAt ? `Updated ${formatDate(status.updatedAt)}` : "Saved"}
            </p>
          </div>
          {pendingAction === "disconnect" ? (
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1.5 text-xs text-muted"
              role="status"
            >
              <Spinner />
              Disconnecting…
            </span>
          ) : (
            <ActionMenu disabled={isBusy} label="Claude Code credential actions">
              <DropdownMenuItem className="text-danger" onSelect={() => void handleDisconnect()}>
                Disconnect
              </DropdownMenuItem>
            </ActionMenu>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Status compact label="Not connected" value="not_started" />
          <p className="text-[13px] text-muted">No Anthropic API key saved yet.</p>
        </div>
      )}

      <form className="space-y-3" onSubmit={handleSave}>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Anthropic API key</span>
          <input
            autoComplete="off"
            className="ui-input font-mono text-[13px]"
            disabled={isBusy}
            onChange={(event) => setCredential(event.target.value)}
            placeholder="sk-ant-…"
            spellCheck={false}
            type="password"
            value={credential}
          />
        </label>

        <div className="flex justify-end">
          <button className="ui-button-primary" disabled={saveDisabled} type="submit">
            <ActionButtonLabel
              idle={status?.connected ? "Update API key" : "Save API key"}
              pending={pendingAction === "save"}
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
