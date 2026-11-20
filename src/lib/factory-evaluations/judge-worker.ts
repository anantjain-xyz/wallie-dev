import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isCostUsd, normalizeMeasuredUsage } from "@/lib/agent-runner/usage";
import { factoryScorerDefinitionSchema } from "@/lib/factory-scorers/contracts";
import type { FactoryScorerResult } from "@/lib/factory-scorers/result";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Json } from "@/lib/supabase/database.types";

import { runFactoryJudge } from "./judge";
import type { FactoryJudgeOutcome } from "./judge-contracts";
import { loadFactoryJudgeEvidence } from "./judge-evidence";
import {
  factoryJudgeClaimSchema,
  factoryJudgePermitSchema,
  factoryJudgePreparationSchema,
  type FactoryJudgeClaim,
} from "./judge-inputs";

type Admin = SupabaseClient<Database>;
type WorkerRuntime = "node" | "workerd";
type PreflightFailure =
  | "evidence_unavailable"
  | "missing_evidence"
  | "unsupported_evidence"
  | "profile_unavailable";
const maxClaims = 4;
const maxEvaluationMs = 55_000;
const rpcTimeoutMs = 5_000;
// A job can record up to six attempts. Its total still fits the API's number range.
const maxAttemptUsage = Math.floor(Number.MAX_SAFE_INTEGER / 6);

function claimIdentity(claim: FactoryJudgeClaim) {
  return {
    p_workspace_id: claim.workspace_id,
    p_factory_id: claim.factory_id,
    p_job_id: claim.job_id,
    p_attempt_id: claim.attempt_id,
    p_lease_id: claim.lease_id,
  };
}

function candidateJson(result: FactoryScorerResult): Json {
  const evidence = result.evidence.map((reference) => ({ ...reference }));
  if ("missingEvidence" in result) {
    return { ...result, evidence, missingEvidence: [...result.missingEvidence] };
  }
  return { ...result, evidence };
}

async function finish(
  admin: Admin,
  identity: ReturnType<typeof claimIdentity>,
  outcome: PreflightFailure | "provider_unavailable" | FactoryJudgeOutcome,
) {
  const evaluation = typeof outcome === "string" ? undefined : outcome;
  const candidate = evaluation?.result;
  const judge = evaluation?.judge;
  const tokens = normalizeMeasuredUsage(judge?.usage?.inputTokens, judge?.usage?.outputTokens);
  const costUsd = judge?.usage?.costUsd;
  let status: string = typeof outcome === "string" ? outcome : "completed";
  if (candidate?.status === "error") status = candidate.reason;
  if (
    !judge &&
    candidate?.status === "inconclusive" &&
    (candidate.reason === "missing_evidence" || candidate.reason === "unsupported_evidence")
  )
    status = candidate.reason;
  const { data, error } = await admin
    .rpc("finish_factory_judge_invocation", {
      ...identity,
      p_status: status,
      ...(candidate ? { p_candidate_result: candidateJson(candidate) } : {}),
      ...(judge?.model ? { p_provider_model: judge.model } : {}),
      ...(judge?.provider ? { p_provider_name: judge.provider } : {}),
      ...(judge?.requestId ? { p_provider_request_id: judge.requestId } : {}),
      ...(evaluation?.explanation ? { p_explanation: evaluation.explanation } : {}),
      ...(evaluation?.locations ? { p_evidence_locations: evaluation.locations } : {}),
      ...(tokens && tokens.inputTokens <= maxAttemptUsage && tokens.outputTokens <= maxAttemptUsage
        ? {
            p_input_tokens: tokens.inputTokens,
            p_output_tokens: tokens.outputTokens,
            p_token_provenance: "measured",
          }
        : {}),
      ...(isCostUsd(costUsd) && costUsd <= maxAttemptUsage
        ? { p_cost_usd: costUsd, p_cost_provenance: "measured" }
        : {}),
    })
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (error) throw new Error("Could not finish the factory judge attempt.");
  return data === true;
}

export async function runClaimedFactoryJudge(
  admin: Admin,
  claim: FactoryJudgeClaim,
  runtime: WorkerRuntime,
) {
  const remainingMs = Math.min(
    maxEvaluationMs,
    Date.parse(claim.lease_expires_at) - Date.now() - rpcTimeoutMs,
  );
  if (remainingMs <= 0) return false;
  const signal = AbortSignal.timeout(remainingMs);
  const identity = claimIdentity(claim);
  const result = await admin.rpc("prepare_factory_judge_invocation", identity).abortSignal(signal);
  const preparation = factoryJudgePreparationSchema.safeParse(result.data);
  if (result.error || !preparation.success)
    throw new Error("Could not prepare the factory judge attempt.");
  const plan = preparation.data;
  if (plan.status === "stale_claim" || plan.status === "already_started") return false;
  if (plan.status !== "ready") return finish(admin, identity, plan.status);
  if (
    !plan.profile.enabled ||
    plan.profile.workspace_id !== claim.workspace_id ||
    plan.target_commit_sha !== claim.target_commit_sha ||
    plan.scorer_revision_id !== claim.scorer_revision_id ||
    plan.sample_receipt_id !== claim.sample_receipt_id ||
    plan.session_id !== claim.session_id ||
    plan.run_id !== claim.run_id
  )
    throw new Error("The factory judge input did not match its current claim.");

  const parsed = factoryScorerDefinitionSchema.safeParse(plan.definition);
  if (!parsed.success) throw new Error("The factory judge received an invalid rubric revision.");
  const definition = parsed.data;
  const input = await loadFactoryJudgeEvidence(
    admin,
    claim,
    plan.evidence,
    definition.rubric,
    signal,
  );
  signal.throwIfAborted();
  if (input.status !== "available") return finish(admin, identity, input.status);
  const authorization = await admin
    .rpc("begin_factory_judge_invocation", {
      ...identity,
      p_profile_revision_id: plan.profile.id,
      p_evidence_digest: input.digest,
      p_worker_runtime: runtime,
    })
    .abortSignal(signal);
  const permit = factoryJudgePermitSchema.safeParse(authorization.data);
  if (authorization.error || !permit.success)
    throw new Error("Could not authorize the factory judge attempt.");
  if (permit.data.status === "stale_claim" || permit.data.status === "already_started")
    return false;
  if (permit.data.status !== "authorized") return finish(admin, identity, permit.data.status);

  let apiKey: string;
  try {
    apiKey = decryptSecretValue(permit.data.encrypted_api_key);
  } catch {
    return finish(admin, identity, "provider_unavailable");
  }
  const outcome = await runFactoryJudge({
    definition,
    evidence: input.evidence,
    profile: {
      model: plan.profile.model_id,
      provider: plan.profile.provider_route,
      allowImage: plan.profile.allow_images,
      allowVideo: plan.profile.allow_video,
    },
    apiKey,
    signal,
  });
  return finish(admin, identity, outcome);
}

export async function drainFactoryJudges(admin: Admin, runtime: WorkerRuntime) {
  const running: Promise<boolean>[] = [];
  try {
    for (let claimCount = 0; claimCount < maxClaims; claimCount += 1) {
      const { data, error } = await admin
        .rpc("claim_factory_judge_job")
        .abortSignal(AbortSignal.timeout(rpcTimeoutMs))
        .maybeSingle();
      if (error) throw new Error("Could not claim a factory judge attempt.");
      if (!data) break;
      const claim = factoryJudgeClaimSchema.safeParse(data);
      if (!claim.success) throw new Error("The evaluation worker received an invalid claim.");
      running.push(
        runClaimedFactoryJudge(admin, claim.data, runtime).catch(() => {
          console.warn("[factory-judge] attempt will recover at lease expiry");
          return false;
        }),
      );
    }
  } finally {
    await Promise.all(running);
  }
}
