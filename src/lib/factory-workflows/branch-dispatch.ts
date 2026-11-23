import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import type { WorkflowOccurrencePin } from "./deterministic-command";

type Admin = SupabaseClient<Database>;
const BRANCH_RPC_TIMEOUT_MS = 5_000;

const branchProgressSchema = z.union([
  z.object({ blocker: z.literal("workflow_branch_source_changed") }),
  z.object({
    groupId: z.string().uuid(),
    joinStatus: z.enum(["pending", "ready", "required_blocked", "optional_failure"]),
    admissionBlocker: z
      .enum([
        "workflow_visit_limit_exhausted",
        "workflow_child_limit",
        "workflow_child_attempt_limit",
        "workflow_branch_admission_unavailable",
      ])
      .optional(),
  }),
]);

export async function advanceFactoryWorkflowBranchOccurrence(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(BRANCH_RPC_TIMEOUT_MS);
  const { data, error } = await admin
    .rpc("advance_factory_workflow_branch_occurrence", {
      p_workspace_id: pin.p_workspace_id,
      p_factory_id: pin.p_factory_id,
      p_root_session_id: pin.p_root_session_id,
      p_expected_generation: pin.p_expected_generation,
      p_ownership_token: pin.p_ownership_token,
      p_occurrence_id: pin.occurrenceId,
    })
    .abortSignal(signal ? AbortSignal.any([signal, deadline]) : deadline);
  if (error) throw error;
  if (data === null) return { status: "pending", code: "branch_group_pending" } as const;
  const progress = branchProgressSchema.parse(data);
  if ("blocker" in progress) return { status: "blocked", code: progress.blocker } as const;
  return { status: "branch" as const, ...progress };
}

/** Each call advances one due group under its locked root generation. */
export async function drainFactoryWorkflowBranches(admin: Admin) {
  for (let processed = 0; processed < 4; processed++) {
    const { data, error } = await admin
      .rpc("dispatch_next_factory_workflow_branch")
      .abortSignal(AbortSignal.timeout(BRANCH_RPC_TIMEOUT_MS));
    if (error) throw error;
    if (!data) break;
  }
}
