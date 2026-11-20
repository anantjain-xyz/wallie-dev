import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  evaluationReceiptPageSchema,
  type FactoryEvaluationReceiptRecord,
  maxJobEvaluationReceipts,
} from "./evaluation-receipt-contracts";

type Client = Pick<SupabaseClient<Database>, "rpc">;
type ReceiptScope = {
  workspaceId: string;
  factoryId: string;
  evaluationId: string;
  actorUserId: string;
};

function mapReceipt(receipt: FactoryEvaluationReceiptRecord) {
  return {
    attemptId: receipt.attempt_id,
    sessionId: receipt.session_id,
    runId: receipt.run_id,
    scorerRevisionId: receipt.scorer_revision_id,
    sampleReceiptId: receipt.sample_receipt_id,
    targetCommitSha: receipt.target_commit_sha,
    attemptNumber: receipt.attempt_number,
    attemptOutcome: receipt.attempt_outcome,
    profileRevisionId: receipt.profile_revision_id,
    providerModel: receipt.provider_model,
    providerName: receipt.provider_name,
    providerRequestId: receipt.provider_request_id,
    adapterRuntime: receipt.adapter_runtime,
    workerRuntime: receipt.worker_runtime,
    evidenceDigest: receipt.evidence_digest,
    evidenceAvailability: receipt.evidence_availability,
    evidenceLocations: receipt.evidence_locations,
    status: receipt.status,
    reason: receipt.reason,
    score: receipt.score,
    result: receipt.result,
    explanation: receipt.explanation,
    claimedAt: receipt.claimed_at,
    startedAt: receipt.started_at,
    finishedAt: receipt.finished_at,
    latencyMs: receipt.latency_ms,
    usage: {
      inputTokens: receipt.input_tokens,
      outputTokens: receipt.output_tokens,
      tokenProvenance: receipt.token_provenance,
      costUsd: receipt.cost_usd,
      costProvenance: receipt.cost_provenance,
      estimationRevision: receipt.estimation_revision,
    },
  };
}

export async function readFactoryEvaluationReceipts(client: Client, scope: ReceiptScope) {
  const workspaceId = scope.workspaceId.toLowerCase();
  const factoryId = scope.factoryId.toLowerCase();
  const evaluationId = scope.evaluationId.toLowerCase();
  const { data, error } = await client
    .rpc("list_factory_evaluation_receipts", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_job_id: evaluationId,
      p_actor_user_id: scope.actorUserId,
      p_limit: maxJobEvaluationReceipts,
    })
    .abortSignal(AbortSignal.timeout(5_000));
  if (error?.code === "P0002" || error?.code === "42501") return null;
  if (error) throw error;
  if (data === null) return null;

  const { receipts, usage } = evaluationReceiptPageSchema.parse(data);
  if (!receipts.length) return null;
  if (
    usage?.attempt_count !== receipts.length ||
    receipts.some(
      (receipt) =>
        receipt.workspace_id !== workspaceId ||
        receipt.factory_id !== factoryId ||
        receipt.job_id !== evaluationId,
    )
  ) {
    throw new Error("Evaluation receipt returned an invalid scope.");
  }
  return {
    id: evaluationId,
    receipts: receipts.map(mapReceipt),
    usage: {
      attemptCount: usage.attempt_count,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      tokenUnavailableCount: usage.token_unavailable_count,
      tokenEstimatedCount: usage.token_estimated_count,
      costUsd: usage.cost_usd,
      costUnavailableCount: usage.cost_unavailable_count,
      costEstimatedCount: usage.cost_estimated_count,
    },
  };
}
