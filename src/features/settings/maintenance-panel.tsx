"use client";

import { useState } from "react";

import { Spinner } from "@/components/shared/spinner";
import type { MaintenanceTickResponse } from "@/lib/maintenance/service";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";

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
    payload.reconciliation.canceled +
    payload.processing.processedJobIds.length
  );
}

function successText(payload: MaintenanceTickResponse): string {
  const changed = countChanged(payload);
  if (changed === 0 && payload.processing.result === "idle") {
    return "Maintenance complete. No stuck work was found.";
  }
  if (payload.processing.result === "budget_exhausted") {
    return "Maintenance cleanup completed. Queue processing was skipped because the time budget was nearly exhausted.";
  }
  return `Maintenance complete. ${changed} item${changed === 1 ? "" : "s"} recovered or checked.`;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-background px-3 py-2">
      <span className="text-[11px] font-medium text-muted">{label}</span>
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
    <div className="mt-6 rounded-[10px] border border-border bg-surface px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Maintenance</h3>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            Recover stale runs, reconcile Linear state, and clean up orphaned sandboxes.
          </p>
        </div>
        <button
          type="button"
          className="ui-button-primary shrink-0 gap-1.5"
          disabled={runMaintenance.isBusy}
          onClick={() => void runMaintenance.run()}
        >
          {runMaintenance.isBusy ? (
            <>
              <Spinner />
              <span>Running...</span>
            </>
          ) : (
            "Run maintenance"
          )}
        </button>
      </div>

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
          <SummaryCell label="Processing" value={lastResult.processing.result} />
        </div>
      ) : null}
    </div>
  );
}
