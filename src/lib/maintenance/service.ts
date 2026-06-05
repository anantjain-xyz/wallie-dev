import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { processQueuedAgentJobs } from "@/lib/wallie/service";
import type { Database } from "@/lib/supabase/database.types";
import { reconcileLinearState } from "@/worker/reconciler";
import { reapOrphanSandboxes } from "@/worker/sandbox-reaper";
import { sweepStalledRuns } from "@/worker/stall-detector";

type AdminClient = SupabaseClient<Database>;

const DEFAULT_STALL_TIMEOUT_MS = 900_000;
const DEFAULT_TICK_BUDGET_MS = 270_000;
const MIN_PROCESSING_BUDGET_MS = 60_000;

export type MaintenanceTickResponse = {
  cleanup: {
    stalledRunIds: string[];
    retriedJobIds: string[];
    terminalErroredJobIds: string[];
    stoppedSandboxIds: string[];
    reapedSandboxIds: string[];
    activeProviderSandboxCount: number;
  };
  processing: {
    processedJobIds: string[];
    result: "budget_exhausted" | "error" | "idle" | "success";
    runId: string | null;
  };
  reconciliation: {
    canceled: number;
    checked: number;
    rateLimited: boolean;
  };
};

export async function runMaintenanceTick(input: {
  admin: AdminClient;
  tickBudgetMs?: number;
  workspaceId: string;
}): Promise<MaintenanceTickResponse> {
  const startedAt = Date.now();
  const tickBudgetMs = input.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const deadlineAt = startedAt + tickBudgetMs;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());

  const [stalled, reaped] = await Promise.all([
    sweepStalledRuns(input.admin, DEFAULT_STALL_TIMEOUT_MS, { workspaceId: input.workspaceId }),
    reapOrphanSandboxes(input.admin),
  ]);

  const reconciliation = await reconcileLinearState(input.admin, {
    workspaceId: input.workspaceId,
  });

  let processing: MaintenanceTickResponse["processing"];
  if (remainingMs() < MIN_PROCESSING_BUDGET_MS) {
    processing = {
      processedJobIds: [],
      result: "budget_exhausted",
      runId: null,
    };
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Maintenance tick budget exhausted."));
    }, remainingMs());

    try {
      const processed = await processQueuedAgentJobs({
        admin: input.admin,
        signal: controller.signal,
        workspaceId: input.workspaceId,
      });
      processing = {
        processedJobIds: processed.processed && processed.jobId ? [processed.jobId] : [],
        result: processed.result,
        runId: processed.runId,
      };
    } catch (error) {
      console.error("[maintenance] queue processing failed", {
        error: error instanceof Error ? error.message : String(error),
        workspaceId: input.workspaceId,
      });
      processing = {
        processedJobIds: [],
        result: "error",
        runId: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    cleanup: {
      activeProviderSandboxCount: reaped.activeProviderCount,
      reapedSandboxIds: reaped.reapedSandboxIds,
      retriedJobIds: stalled.retriedJobIds,
      stalledRunIds: stalled.stalledRunIds,
      stoppedSandboxIds: stalled.stoppedSandboxIds,
      terminalErroredJobIds: stalled.stalledJobIds,
    },
    processing,
    reconciliation,
  };
}
