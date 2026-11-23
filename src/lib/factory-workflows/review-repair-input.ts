import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import { FrozenRunContextUnavailableError } from "@/lib/run-context/server";
import type { Database } from "@/lib/supabase/database.types";

const reviewFindingSchema = z.strictObject({
  ruleId: z
    .string()
    .max(96)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  path: z
    .string()
    .max(512)
    .refine(
      (path) =>
        isFactoryDefinitionText(path) &&
        !/^[a-z]:|[\\\u0000-\u001f]/i.test(path) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    )
    .optional(),
  line: z.number().int().positive().safe().optional(),
  message: z.string().min(1).max(1000).refine(isFactoryDefinitionText),
});

export const workflowReviewFindingsSchema = z.array(reviewFindingSchema).min(1).max(32);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requiredEvidence = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
const reviewRepairInput = z.strictObject({
  repairReceiptId: z.string().uuid(),
  sourceCheckpointRunId: z.string().uuid(),
  sourceCommitSha: sha,
  sourceTreeSha: sha,
  findings: workflowReviewFindingsSchema,
  priorRepairReceiptId: z.string().uuid().nullable(),
  requiredEvidence: z.array(requiredEvidence).min(1).max(128),
});

export async function loadWorkflowReviewRepairInput(
  admin: SupabaseClient<Database>,
  input: {
    workspaceId: string;
    sessionId: string;
    jobId: string;
    runId: string;
    attemptCount: number;
    source: { checkpointRunId: string; commitSha: string };
    signal?: AbortSignal;
  },
) {
  const request = admin.rpc("read_factory_workflow_review_repair_input", {
    p_workspace_id: input.workspaceId,
    p_session_id: input.sessionId,
    p_job_id: input.jobId,
    p_run_id: input.runId,
    p_attempt_count: input.attemptCount,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  input.signal?.throwIfAborted();
  if (error)
    throw new FrozenRunContextUnavailableError("The exact review repair could not be read.");
  if (data === null) return null;

  const parsed = reviewRepairInput.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.sourceCheckpointRunId !== input.source.checkpointRunId ||
    parsed.data.sourceCommitSha !== input.source.commitSha
  )
    throw new FrozenRunContextUnavailableError("The exact review repair input changed.");
  return parsed.data;
}
