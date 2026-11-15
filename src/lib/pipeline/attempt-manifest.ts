import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentEffort } from "@/lib/agent-config/contracts";
import { STAGE_PROMPT_RENDERER_VERSION } from "@/lib/prompt-templates";
import type { Database } from "@/lib/supabase/database.types";

import type { loadAttemptPredecessors } from "./stages";

export type AttemptWorkerRuntime = "node" | "workerd";

export async function pinSessionAttemptManifest(input: {
  admin: SupabaseClient<Database>;
  jobId: string;
  runId: string;
  attemptCount: number;
  prompt: string;
  checkoutSha: string;
  predecessors: Awaited<ReturnType<typeof loadAttemptPredecessors>>["predecessors"];
  workerRuntime: AttemptWorkerRuntime;
  credentialOwnerMemberId: string | null;
  effort?: AgentEffort;
  maxTurns?: number;
  signal?: AbortSignal;
}) {
  const bytes = Buffer.from(input.prompt, "utf8");
  const request = input.admin.rpc("pin_session_attempt_manifest", {
    p_job_id: input.jobId,
    p_run_id: input.runId,
    p_attempt_count: input.attemptCount,
    p_prompt_sha256: createHash("sha256").update(bytes).digest("hex"),
    p_prompt_utf8_bytes: bytes.byteLength,
    p_renderer_version: STAGE_PROMPT_RENDERER_VERSION,
    p_checkout_sha: input.checkoutSha,
    p_predecessors: input.predecessors,
    p_worker_runtime: input.workerRuntime,
    ...(input.maxTurns === undefined ? {} : { p_max_turns: input.maxTurns }),
    ...(input.effort === undefined ? {} : { p_agent_effort: input.effort }),
    ...(input.credentialOwnerMemberId === null
      ? {}
      : { p_credential_owner_member_id: input.credentialOwnerMemberId }),
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return data === true;
}
