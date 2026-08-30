"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/shared/spinner";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { ActionMenu } from "@/components/ui/action-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import type { CursorAuthFlowStatus, CursorConnectionStatus } from "@/lib/cursor/contracts";

export type { CursorConnectionStatus } from "@/lib/cursor/contracts";

type FlowResponse = {
  error?: string | null;
  expiresAt: string;
  flowId: string;
  loginUrl?: string | null;
  status: CursorAuthFlowStatus;
};

export function CursorConnectionPanel({
  initialStatus,
  onStatusChange,
  workspaceId,
}: {
  initialStatus?: CursorConnectionStatus;
  onStatusChange?: (status: CursorConnectionStatus) => void;
  workspaceId?: string;
}) {
  const [status, setStatus] = useState<CursorConnectionStatus | null>(initialStatus ?? null);
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const navigatedTargetRef = useRef<string | null>(null);
  const callbackRef = useRef(onStatusChange);
  const { pushToast } = useOptionalToast();

  useEffect(() => {
    callbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/cursor/connection", { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as
      | (CursorConnectionStatus & { error?: string })
      | null;
    if (!response.ok || !data) throw new Error(data?.error ?? "Cursor status check failed.");
    setStatus(data);
    callbackRef.current?.(data);
    return data;
  }, []);

  useEffect(() => {
    if (!initialStatus) void refresh().catch((reason) => setError(errorMessage(reason)));
  }, [initialStatus, refresh]);

  useEffect(() => {
    if (!flow || !["starting", "processing", "prompted"].includes(flow.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/cursor/connection?flowId=${flow.flowId}`, {
          cache: "no-store",
        });
        const next = (await response.json()) as FlowResponse;
        if (!response.ok) throw new Error(next.error ?? "Cursor sign-in status failed.");
        setFlow(next);
        if (
          next.loginUrl &&
          navigatedTargetRef.current !== `${next.flowId}:${next.loginUrl}` &&
          popupRef.current &&
          !popupRef.current.closed
        ) {
          popupRef.current.location.href = next.loginUrl;
          navigatedTargetRef.current = `${next.flowId}:${next.loginUrl}`;
        }
        if (next.status === "authenticated") {
          window.clearInterval(timer);
          popupRef.current?.close();
          await refresh();
          setPending(null);
          pushToast({ priority: "polite", title: "Cursor connected.", tone: "success" });
        } else if (["error", "expired", "canceled"].includes(next.status)) {
          window.clearInterval(timer);
          popupRef.current?.close();
          setPending(null);
          if (next.status !== "canceled")
            setError(next.error ?? "Cursor sign-in did not complete.");
        }
      } catch (reason) {
        window.clearInterval(timer);
        setPending(null);
        setError(errorMessage(reason));
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [flow, pushToast, refresh]);

  const connect = async () => {
    if (pending) return;
    navigatedTargetRef.current = null;
    popupRef.current = window.open(
      "about:blank",
      "wallie-cursor-login",
      "popup,width=720,height=760",
    );
    setPending("connect");
    setError(null);
    try {
      const response = await fetch("/api/cursor/connection", {
        body: JSON.stringify({ workspaceId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await response.json()) as FlowResponse;
      if (!response.ok) throw new Error(data.error ?? "Could not start Cursor sign-in.");
      setFlow(data);
    } catch (reason) {
      popupRef.current?.close();
      setPending(null);
      setError(errorMessage(reason));
    }
  };

  const disconnect = async () => {
    setPending("disconnect");
    setError(null);
    try {
      const response = await fetch("/api/cursor/connection", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not disconnect Cursor.");
      await refresh();
      pushToast({ priority: "polite", title: "Cursor disconnected.", tone: "success" });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  };

  const reconnect = status?.expired || status?.reconnectRequired;
  return (
    <div className="space-y-4">
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}
      {status?.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-foreground">
                {status.accountEmail ?? "Cursor account"}
              </p>
              <Status compact label="Connected" value="healthy" />
            </div>
            <p className="mt-1 text-xs text-muted">
              {status.expiresAt ? `Access expires ${formatDate(status.expiresAt)}` : "Connected"}
            </p>
          </div>
          <ActionMenu disabled={pending !== null} label="Cursor credential actions">
            <DropdownMenuItem className="text-danger" onSelect={() => void disconnect()}>
              Disconnect
            </DropdownMenuItem>
          </ActionMenu>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Status
            compact
            label={reconnect ? "Reconnect required" : "Not connected"}
            value={reconnect ? "needs_attention" : "not_started"}
          />
          <p className="text-[13px] text-muted">
            {status?.reconnectReason ?? "Sign in to use the models available on your Cursor plan."}
          </p>
        </div>
      )}
      {!status?.connected ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {flow?.loginUrl ? (
            <a
              className="ui-button-secondary"
              href={flow.loginUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open sign-in
            </a>
          ) : null}
          <button
            className="ui-button-primary"
            disabled={pending !== null}
            onClick={() => void connect()}
            type="button"
          >
            <ActionButtonLabel
              idle={reconnect ? "Reconnect Cursor" : "Sign in with Cursor"}
              pending={pending === "connect"}
              pendingLabel={flow?.status === "prompted" ? "Waiting for sign-in…" : "Starting…"}
            />
          </button>
        </div>
      ) : pending === "disconnect" ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Spinner />
          Disconnecting…
        </span>
      ) : null}
    </div>
  );
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : "Cursor connection failed.";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
