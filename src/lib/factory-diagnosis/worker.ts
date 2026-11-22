import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import {
  diagnosisClaimSchema,
  diagnosisPermitSchema,
  diagnosisPreparationSchema,
  maximumDiagnosisDurationMs,
  type DiagnosisClaim,
} from "./contracts";
import { runDiagnosisInference, type DiagnosisInferenceOutcome } from "./inference";

type Admin = SupabaseClient<Database>;
type WorkerRuntime = "node" | "workerd";
const rpcTimeoutMs = 4_000;
const cancellationPollMs = 3_000;

function claimIdentity(claim: DiagnosisClaim) {
  return {
    p_workspace_id: claim.workspace_id,
    p_factory_id: claim.factory_id,
    p_diagnosis_id: claim.diagnosis_id,
    p_attempt_id: claim.attempt_id,
    p_lease_id: claim.lease_id,
  };
}

async function finishDiagnosis(
  admin: Admin,
  identity: ReturnType<typeof claimIdentity>,
  runtime: WorkerRuntime,
  outcome: DiagnosisInferenceOutcome,
) {
  const { data, error } = await admin
    .rpc("finish_factory_diagnosis", {
      ...identity,
      p_status: outcome.status,
      ...(outcome.status === "completed" ? { p_result: outcome.result } : {}),
      p_trace: { worker_runtime: runtime, ...outcome.trace },
      ...(outcome.usage ? { p_usage: outcome.usage } : {}),
    })
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (error) throw new Error("Could not finish the factory diagnosis.");
  return data === true;
}

export async function runClaimedFactoryDiagnosis(
  admin: Admin,
  claim: DiagnosisClaim,
  runtime: WorkerRuntime,
) {
  const leaseBudgetMs = Math.min(
    maximumDiagnosisDurationMs,
    Date.parse(claim.lease_expires_at) - Date.now(),
  );
  if (leaseBudgetMs <= rpcTimeoutMs) return false;
  const leaseSignal = AbortSignal.timeout(leaseBudgetMs);
  const identity = claimIdentity(claim);
  const prepared = await admin.rpc("prepare_factory_diagnosis", identity).abortSignal(leaseSignal);
  if (prepared.error) throw new Error("Could not prepare the factory diagnosis.");
  if (prepared.data === null || leaseSignal.aborted) return false;
  const preparation = diagnosisPreparationSchema.safeParse(prepared.data);
  if (!preparation.success) throw new Error("The factory diagnosis preparation was invalid.");

  const begun = await admin
    .rpc("begin_factory_diagnosis", {
      ...identity,
      p_evidence_digest: preparation.data.evidence_digest,
    })
    .abortSignal(leaseSignal);
  if (begun.error) throw new Error("Could not authorize the factory diagnosis.");
  if (begun.data === null || leaseSignal.aborted) return false;
  const permit = diagnosisPermitSchema.safeParse(begun.data);
  if (!permit.success) throw new Error("The factory diagnosis permit was invalid.");

  const remainingMs = Math.min(
    preparation.data.budget.max_execution_ms,
    Date.parse(permit.data.deadline_at) - Date.now() - rpcTimeoutMs,
    Date.parse(claim.lease_expires_at) - Date.now() - rpcTimeoutMs,
  );
  if (remainingMs <= 0) return finishDiagnosis(admin, identity, runtime, { status: "timeout" });
  const inferenceDeadline = AbortSignal.any([leaseSignal, AbortSignal.timeout(remainingMs)]);
  const canceled = new AbortController();
  const signal = AbortSignal.any([inferenceDeadline, canceled.signal]);

  let checking = false;
  const checkClaim = async () => {
    if (checking || signal.aborted) return;
    checking = true;
    try {
      const { data, error } = await admin
        .rpc("is_factory_diagnosis_claim_current", identity)
        .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(rpcTimeoutMs)]));
      if (error || data !== true) canceled.abort();
    } catch {
      canceled.abort();
    } finally {
      checking = false;
    }
  };
  await checkClaim();
  if (signal.aborted) return finishDiagnosis(admin, identity, runtime, { status: "timeout" });

  let apiKey: string;
  try {
    apiKey = decryptSecretValue(permit.data.encrypted_api_key);
  } catch {
    return finishDiagnosis(admin, identity, runtime, { status: "provider_unavailable" });
  }

  const timer = setInterval(() => void checkClaim(), cancellationPollMs);
  try {
    const outcome = await runDiagnosisInference({ preparation: preparation.data, apiKey, signal });
    return await finishDiagnosis(
      admin,
      identity,
      runtime,
      canceled.signal.aborted ? { status: "timeout" } : outcome,
    );
  } finally {
    clearInterval(timer);
    canceled.abort();
  }
}

export async function drainFactoryDiagnoses(admin: Admin, runtime: WorkerRuntime) {
  const { data, error } = await admin
    .rpc("claim_factory_diagnosis")
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (error) throw new Error("Could not claim a factory diagnosis.");
  if (data === null) return false;
  const claim = diagnosisClaimSchema.safeParse(data);
  if (!claim.success) throw new Error("The factory diagnosis claim was invalid.");
  return runClaimedFactoryDiagnosis(admin, claim.data, runtime);
}
