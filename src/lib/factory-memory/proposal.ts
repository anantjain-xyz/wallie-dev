import "server-only";

import { createHash } from "node:crypto";

import { trustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { readSandboxBoundedTextFile } from "@/lib/sandbox/bounded-text-file";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { redactValidationText } from "@/lib/validation-evidence/capture";

import { FACTORY_MEMORY_BODY_BYTES, memoryBodySchema } from "./contracts";

export function factoryMemoryProposalPath(runId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid memory proposal run identity.");
  return `/tmp/wallie-memory-proposal-${runId}.md`;
}

export function factoryMemoryProposalInstructions(runId: string) {
  return trustedPromptValue(
    "wallie.factoryMemoryProposalPolicy",
    `## Optional factory memory proposal

If the run independently established a reusable project fact, you may write one short, non-sensitive Markdown note to \`${factoryMemoryProposalPath(runId)}\`. Keep it within 4 KiB. Put the note only in that file, outside the checkout. A factory manager must import and approve the proposal before future runs can retrieve it.`,
  );
}

export async function stageFactoryMemoryProposal(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  sandbox: SandboxHandle;
  workspaceId: string;
  jobId: string;
  runId: string;
  attemptCount: number;
  artifactMarkdown: string;
  secrets: readonly string[];
  signal?: AbortSignal;
}) {
  const text = await readSandboxBoundedTextFile({
    sandbox: input.sandbox,
    path: factoryMemoryProposalPath(input.runId),
    maxBytes: FACTORY_MEMORY_BODY_BYTES,
    signal: input.signal,
  });
  const proposal = memoryBodySchema.safeParse(text?.trim());
  if (
    !proposal.success ||
    input.artifactMarkdown.includes(proposal.data) ||
    redactValidationText(proposal.data, input.secrets) !== proposal.data
  ) {
    return;
  }
  const stage = input.admin.rpc("stage_factory_run_memory_proposal", {
    p_workspace_id: input.workspaceId,
    p_job_id: input.jobId,
    p_run_id: input.runId,
    p_attempt_count: input.attemptCount,
    p_artifact_sha256: createHash("sha256").update(input.artifactMarkdown, "utf8").digest("hex"),
    p_body_md: proposal.data,
  });
  const result = await (input.signal ? stage.abortSignal(input.signal) : stage);
  input.signal?.throwIfAborted();
  if (result.error || result.data !== true) {
    throw new Error("The factory memory proposal could not be associated with its producing run.");
  }
}
