import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { FrozenRunContextUnavailableError } from "@/lib/run-context/server";
import type { Database } from "@/lib/supabase/database.types";

import { acceptedTriageScopePinSchema, prepareAcceptedTriageInput } from "./triage-scope";

const scopeResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ordinary") }),
  z.strictObject({
    status: z.literal("required"),
    receiptId: z.uuid(),
    pin: acceptedTriageScopePinSchema,
    artifactMarkdown: z.string().max(16_384),
  }),
]);

export async function loadDelegatedAcceptedScope(
  admin: SupabaseClient<Database>,
  attempt: { workspaceId: string; jobId: string; runId: string; attemptCount: number },
  signal?: AbortSignal,
) {
  const query = admin.rpc("read_factory_workflow_delegated_scope", {
    p_workspace_id: attempt.workspaceId,
    p_job_id: attempt.jobId,
    p_run_id: attempt.runId,
    p_attempt_count: attempt.attemptCount,
  });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  const response = scopeResponseSchema.safeParse(data);
  if (error || !response.success) {
    throw new FrozenRunContextUnavailableError(
      "The assigned accepted scope could not be verified.",
    );
  }
  if (response.data.status === "ordinary") return null;
  const { pin, artifactMarkdown } = response.data;
  if (pin.workspaceId !== attempt.workspaceId) {
    throw new FrozenRunContextUnavailableError(
      "The assigned accepted scope belongs to another workspace.",
    );
  }
  // The native reader only returns a matching allocation and live observation
  // after it locks the exact started child attempt.
  const accepted = prepareAcceptedTriageInput({
    assignment: pin,
    observation: { pin, artifactMarkdown },
  });
  if (accepted.status !== "ready") {
    throw new FrozenRunContextUnavailableError(
      "The approved scope artifact did not match its receipt.",
    );
  }
  return accepted;
}
