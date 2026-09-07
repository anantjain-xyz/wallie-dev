import type { SessionPhaseStatus } from "@/features/sessions/types";
import type { Enums } from "@/lib/supabase/database.types";

export type SessionDisplayStatus = SessionPhaseStatus | "failed";

/** Match the latest run's failure state across session surfaces. */
export function sessionDisplayStatus({
  latestRunStatus,
  phaseStatus,
}: {
  latestRunStatus?: Enums<"agent_run_status"> | null;
  phaseStatus: SessionPhaseStatus;
}): SessionDisplayStatus {
  return latestRunStatus === "error" ? "failed" : phaseStatus;
}
