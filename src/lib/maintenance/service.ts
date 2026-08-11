import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { reconcileLinearState } from "@/worker/reconciler";
import { reapOrphanSandboxes } from "@/worker/sandbox-reaper";
import { sweepStalledRuns } from "@/worker/stall-detector";

type AdminClient = SupabaseClient<Database>;

const DEFAULT_STALL_TIMEOUT_MS = 900_000;

export type MaintenanceTickResponse = {
  cleanup: {
    stalledRunIds: string[];
    retriedJobIds: string[];
    terminalErroredJobIds: string[];
    stoppedSandboxIds: string[];
    reapedSandboxIds: string[];
    activeProviderSandboxCount: number;
  };
  reconciliation: {
    canceled: number;
    checked: number;
    rateLimited: boolean;
  };
};

export async function runMaintenanceTick(input: {
  admin: AdminClient;
  workspaceId: string;
}): Promise<MaintenanceTickResponse> {
  const [stalled, reaped] = await Promise.all([
    sweepStalledRuns(input.admin, DEFAULT_STALL_TIMEOUT_MS, { workspaceId: input.workspaceId }),
    reapOrphanSandboxes(input.admin),
  ]);

  const reconciliation = await reconcileLinearState(input.admin, {
    workspaceId: input.workspaceId,
  });
  return {
    cleanup: {
      activeProviderSandboxCount: reaped.activeProviderCount,
      reapedSandboxIds: reaped.reapedSandboxIds,
      retriedJobIds: stalled.retriedJobIds,
      stalledRunIds: stalled.stalledRunIds,
      stoppedSandboxIds: stalled.stoppedSandboxIds,
      terminalErroredJobIds: stalled.stalledJobIds,
    },
    reconciliation,
  };
}
