import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Tables } from "@/lib/supabase/database.types";

const uuid = z.string().uuid();
const result = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ordinary") }),
  z.strictObject({ kind: z.literal("retired") }),
  z.strictObject({ kind: z.literal("started_elsewhere") }),
  z.strictObject({
    kind: z.literal("started"),
    rootSessionId: uuid,
    workspaceId: uuid,
    factoryId: uuid,
    parentSessionId: uuid,
    joinId: uuid,
    jobId: uuid,
    runId: uuid,
    attemptCount: z.number().int().positive().safe(),
    generation: z.number().int().positive().safe(),
    ownershipToken: uuid,
    artifactVersion: z.number().int().nonnegative().safe(),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    baseRef: z.string().nullable(),
    deadlineAt: z.string().datetime({ offset: true }),
    deadlineReason: z.enum(["worker", "elapsed_execution"]),
  }),
]);

export async function startFactoryWorkflowJoinClaim({
  admin,
  job,
  deadlineAt,
  signal,
}: {
  admin: SupabaseClient<Database>;
  job: Pick<Tables<"agent_jobs">, "id" | "workspace_id" | "session_id" | "attempt_count">;
  deadlineAt: string;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const command = await admin
    .rpc("start_factory_workflow_join_attempt", {
      p_job_id: job.id,
      p_workspace_id: job.workspace_id,
      p_session_id: job.session_id,
      p_attempt_count: job.attempt_count,
      p_deadline_at: deadlineAt,
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (command.error) throw command.error;
  const claim = result.parse(command.data);
  if (
    claim.kind === "started" &&
    (claim.jobId !== job.id ||
      claim.workspaceId !== job.workspace_id ||
      claim.parentSessionId !== job.session_id ||
      claim.attemptCount !== job.attempt_count)
  )
    throw new Error("The workflow join returned a different captured attempt.");
  return claim;
}
