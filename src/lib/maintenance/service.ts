import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";
import type { MaintenanceTickResponse } from "@/lib/maintenance/contracts";
import type { Database } from "@/lib/supabase/database.types";
import { reconcileLinearState } from "@/worker/reconciler";
import { sweepStalledRuns } from "@/worker/stall-detector";

type AdminClient = SupabaseClient<Database>;

const DEFAULT_STALL_TIMEOUT_MS = 900_000;

async function reportCheck<T>(name: string, check: () => Promise<T>): Promise<T | null> {
  try {
    return await check();
  } catch {
    console.error(`[workspace-maintenance] ${name} did not finish`);
    return null;
  }
}

export async function runMaintenanceTick({
  admin,
  workspaceId,
}: {
  admin: AdminClient;
  workspaceId: string;
}): Promise<MaintenanceTickResponse> {
  if (!z.string().uuid().safeParse(workspaceId).success) {
    throw new Error("Workspace maintenance requires a valid workspace id.");
  }

  const stalled = await reportCheck("Stalled-job recovery", () =>
    sweepStalledRuns(admin, DEFAULT_STALL_TIMEOUT_MS, { workspaceId }),
  );

  const [reconciliation, githubVerification] = await Promise.all([
    reportCheck("Linear reconciliation", () => reconcileLinearState(admin, { workspaceId })),
    reportCheck("GitHub verification", () => reconcileGitHubPrVerification(admin, { workspaceId })),
  ]);
  return {
    cleanup: stalled
      ? {
          retriedJobIds: stalled.retriedJobIds,
          stalledRunIds: stalled.stalledRunIds,
          stoppedSandboxIds: stalled.stoppedSandboxIds,
          terminalErroredJobIds: stalled.stalledJobIds,
          ...(stalled.incomplete ? { incomplete: true } : {}),
        }
      : null,
    reconciliation,
    githubVerification,
  };
}
