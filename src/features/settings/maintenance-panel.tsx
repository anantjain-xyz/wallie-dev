"use client";

import { useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import type { MaintenanceTickResponse } from "@/lib/maintenance/service";

type MaintenancePanelProps = {
  canManage: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

function countChanged(payload: MaintenanceTickResponse): number {
  return (
    payload.cleanup.stalledRunIds.length +
    payload.cleanup.retriedJobIds.length +
    payload.cleanup.terminalErroredJobIds.length +
    payload.cleanup.stoppedSandboxIds.length +
    payload.cleanup.reapedSandboxIds.length +
    payload.reconciliation.canceled
  );
}

function successText(payload: MaintenanceTickResponse): string {
  const changed = countChanged(payload);
  if (changed === 0) {
    return "Maintenance complete. No stuck work was found; queued jobs remain with the worker.";
  }
  return `Maintenance complete. ${changed} item${changed === 1 ? "" : "s"} recovered or checked; queued jobs remain with the worker.`;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-canvas px-3 py-2">
      <span className="type-label text-muted">{label}</span>
      <span className="text-[13px] font-semibold text-foreground">{value}</span>
    </div>
  );
}

export function MaintenancePanel({
  canManage,
  setFlashMessage,
  workspaceId,
}: MaintenancePanelProps) {
  const [lastResult, setLastResult] = useState<MaintenanceTickResponse | null>(null);
  const runMaintenance = useApiAction<MaintenanceTickResponse>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/maintenance/tick`, {
        method: "POST",
      }),
    errorText: "Maintenance failed.",
    onSuccess: (payload) => setLastResult(payload),
    setFlashMessage,
    successText,
  });

  if (!canManage) {
    return null;
  }

  return (
    <div className="rounded-[6px] border border-border bg-sheet px-5 py-4">
      <button
        type="button"
        className="ui-button-primary shrink-0 gap-1.5"
        disabled={runMaintenance.isBusy}
        onClick={() => void runMaintenance.run()}
      >
        <ActionButtonLabel
          idle="Run maintenance"
          pending={runMaintenance.isBusy}
          pendingLabel="Running…"
        />
      </button>

      {lastResult ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <SummaryCell
            label="Stalled runs"
            value={String(lastResult.cleanup.stalledRunIds.length)}
          />
          <SummaryCell
            label="Retried jobs"
            value={String(lastResult.cleanup.retriedJobIds.length)}
          />
          <SummaryCell
            label="Errored jobs"
            value={String(lastResult.cleanup.terminalErroredJobIds.length)}
          />
          <SummaryCell
            label="Stopped sandboxes"
            value={String(
              lastResult.cleanup.stoppedSandboxIds.length +
                lastResult.cleanup.reapedSandboxIds.length,
            )}
          />
          <SummaryCell
            label="Linear checked"
            value={`${lastResult.reconciliation.checked}${
              lastResult.reconciliation.rateLimited ? " rate limited" : ""
            }`}
          />
        </div>
      ) : null}
    </div>
  );
}
