import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  deliveryRequirementsSchema,
  type DeliveryRequirements,
} from "@/lib/delivery-policy/contracts";
import type { ValidationEvidenceRecord } from "@/lib/validation-evidence/contracts";
import { evaluateValidationEvidence } from "@/lib/validation-evidence/evaluate";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { PrReadinessStatus } from "@/lib/pipeline/types";

type AdminClient = SupabaseClient<Database>;

/** Readiness states a server evaluation can produce. `not_applicable` is derived from an analysis policy, never recorded for code. */
export type PrReadinessEvaluationState = Exclude<PrReadinessStatus, "not_applicable">;

/** A named delivery requirement failure. Fixed codes only; provider text never enters here. */
export type PrReadinessBlocker = { code: string; requirement?: string };

/** Minimal trusted receipt persisted with every Ready decision (checked again by the storage guard). */
export type PrReadinessSummary = {
  githubAccess: "available";
  checks: "passed";
  reviews: "passed";
  evidence: "passed";
  threads: "passed";
};

/** One evaluated verification dimension. Unknown fails closed; it is never success. */
export type PrReadinessDimensionOutcome = "passed" | "checking" | "blocked" | "unknown";

export type PrReadinessEvaluation = {
  state: PrReadinessEvaluationState;
  blockers: PrReadinessBlocker[];
  summary: PrReadinessSummary | null;
  dimensions: {
    githubAccess: PrReadinessDimensionOutcome;
    identity: PrReadinessDimensionOutcome;
    checks: PrReadinessDimensionOutcome;
    reviews: PrReadinessDimensionOutcome;
    threads: PrReadinessDimensionOutcome;
    evidence: PrReadinessDimensionOutcome;
    mergeability: PrReadinessDimensionOutcome;
  };
};

const dimensionOutcomeSchema = z.enum(["passed", "checking", "blocked", "unknown"]);

/** The OP-506 collector's authoritative payload. Strips extra evidence detail the evaluator does not re-derive. */
export const githubObservationPayloadSchema = z.object({
  version: z.literal(1),
  githubAccess: z.literal("available"),
  checks: dimensionOutcomeSchema,
  reviews: dimensionOutcomeSchema,
  threads: dimensionOutcomeSchema,
  mergeability: dimensionOutcomeSchema,
  protection: z.enum(["verified", "unknown"]),
  blockers: z.array(
    z
      .object({
        code: z.string().min(1).max(200),
        requirement: z.string().min(1).max(200).optional(),
      })
      .strict(),
  ),
  pr: z
    .object({
      number: z.number().int().positive().safe(),
      state: z.enum(["open", "closed", "merged"]),
      draft: z.boolean(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      baseSha: z.string().regex(/^[a-f0-9]{40}$/),
      updatedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type GitHubObservationPayload = z.infer<typeof githubObservationPayloadSchema>;

/** Stored OP-507 harness receipts are re-validated before any can support Ready. */
const storedEvidenceRecordSchema = z.object({
  key: z.string().min(1).max(200),
  command: z.string(),
  provenance: z.literal("harness"),
  status: z.enum(["passed", "failed", "stale", "error"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  commitSha: z.string().nullable(),
  treeSha: z.string().nullable(),
  finalCommitSha: z.string().nullable(),
  finalTreeSha: z.string().nullable(),
  reportKeys: z.array(z.string().max(200)),
  missingRequiredReports: z.array(z.string().max(200)),
});

export const storedEvidenceRecordsSchema = z.array(storedEvidenceRecordSchema).max(100);

export type StoredEvidenceRecord = z.infer<typeof storedEvidenceRecordSchema>;

/** Everything the deterministic evaluator needs; nothing here is client-supplied. */
export type PrReadinessEvaluatorInput = {
  requirements: DeliveryRequirements;
  github: {
    observation: {
      id: string;
      policyRevisionId: string;
      repositoryId: string;
      repositoryFullName: string;
      prEpochId: string;
      prNumber: number;
      headSha: string;
      baseSha: string;
      checkpointRunId: string;
      artifactReviewRevision: number;
      observedAt: string;
    };
    payload: GitHubObservationPayload;
  } | null;
  /** Refresh-queue status for the consumed observation's session. */
  refreshQueueStatus: "current" | "pending" | "claimed" | "error" | null;
  /** Known repository/installation availability for the consumed observation. */
  repository: { archived: boolean; installationSuspended: boolean } | null;
  checkpoint: { runId: string; outputSha: string } | null;
  epoch: { id: string; prNumber: number } | null;
  syncStatus: string | null;
  policyRevisionId: string;
  reviewRevision: number;
  evidence: {
    commitSha: string;
    validationTreeSha: string;
    records: StoredEvidenceRecord[];
    accessibleAssetKeys: ReadonlySet<string>;
  } | null;
  blockingFeedbackCount: number;
};

const EVIDENCE_BLOCKER_CODE: Record<string, string> = {
  missing: "evidence_missing",
  stale: "evidence_stale",
  failed: "evidence_failed",
  unavailable: "evidence_unavailable",
};

const MAX_BLOCKERS = 64;

/** unknown > blocked > checking > passed: unknown fails closed hardest. */
function collapseOutcomes(outcomes: PrReadinessDimensionOutcome[]): PrReadinessDimensionOutcome {
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("blocked")) return "blocked";
  if (outcomes.includes("checking")) return "checking";
  return "passed";
}

function combineState(
  dimensions: PrReadinessEvaluation["dimensions"],
  prState: "open" | "closed" | "merged",
): PrReadinessEvaluationState {
  if (prState === "merged") return "merged";
  if (prState === "closed") return "closed";
  const collapsed = collapseOutcomes(Object.values(dimensions));
  if (collapsed === "passed") return "ready";
  if (collapsed === "blocked") return "blocked";
  if (collapsed === "checking") return "checking";
  return "unknown";
}

/**
 * Deterministic readiness decision. Every unknown input fails closed with a
 * named blocker; nothing absent is treated as satisfied, and no client can
 * supply an outcome. `merged`/`closed` come only from the authoritative GitHub
 * observation. Ready never depends on artifact approval, which would cycle.
 */
export function evaluatePrReadiness(input: PrReadinessEvaluatorInput): PrReadinessEvaluation {
  const blockers: PrReadinessBlocker[] = [];
  const add = (code: string, requirement?: string) =>
    blockers.push({ code, ...(requirement ? { requirement } : {}) });
  const github = input.github?.payload ?? null;
  const githubIdentity = input.github?.observation ?? null;

  if (!github || !githubIdentity) {
    return {
      state: "unknown",
      blockers: [{ code: "github_observation_missing" }],
      summary: null,
      dimensions: {
        githubAccess: "unknown",
        identity: "unknown",
        checks: "unknown",
        reviews: "unknown",
        threads: "unknown",
        evidence: "unknown",
        mergeability: "unknown",
      },
    };
  }

  // GitHub access is attested only by a completed authoritative collection,
  // and only while its repository and installation remain available.
  let githubAccess: PrReadinessDimensionOutcome =
    github.githubAccess === "available" ? "passed" : "unknown";
  if (githubAccess !== "passed") add("github_access_unavailable");
  if (!input.repository) {
    githubAccess = "unknown";
    add("github_repository_unavailable");
  } else {
    if (input.repository.archived) {
      githubAccess = "unknown";
      add("github_repository_archived");
    }
    if (input.repository.installationSuspended) {
      githubAccess = "unknown";
      add("github_installation_suspended");
    }
  }

  // Current checkpoint/PR synchronization: the decision binds to the exact
  // canonical PR and accepted checkpoint the session holds right now. A
  // missing/pending identity is unknown (never success); a PR head that
  // differs from the accepted checkpoint is definitively blocked.
  const identityBlockers: PrReadinessBlocker[] = [];
  let identity: PrReadinessDimensionOutcome = "passed";
  const identityLower = (outcome: PrReadinessDimensionOutcome, code: string) => {
    identity = collapseOutcomes([identity, outcome]);
    identityBlockers.push({ code });
  };
  if (!input.epoch) identityLower("unknown", "canonical_pr_missing");
  else if (
    githubIdentity.prEpochId !== input.epoch.id ||
    githubIdentity.prNumber !== input.epoch.prNumber
  )
    identityLower("unknown", "pr_epoch_changed");
  if (!input.syncStatus) identityLower("unknown", "pr_sync_missing");
  else if (input.syncStatus !== "synced") identityLower("checking", "pr_sync_pending");
  if (!input.checkpoint) identityLower("unknown", "checkpoint_missing");
  else if (githubIdentity.checkpointRunId !== input.checkpoint.runId)
    identityLower("unknown", "checkpoint_changed");
  else if (github.pr.headSha !== input.checkpoint.outputSha)
    identityLower("blocked", "pr_head_checkpoint_mismatch");
  if (githubIdentity.policyRevisionId !== input.policyRevisionId)
    identityLower("unknown", "policy_revision_changed");
  if (githubIdentity.artifactReviewRevision !== input.reviewRevision)
    identityLower("unknown", "review_revision_changed");

  // Observation currency mirrors the delivery gate's currentness view: a
  // decision may only be Ready while the refresh queue is clean and the
  // consumed collection is within configured freshness. The review-time
  // display then never shows Ready when the approval gate would reject.
  if (!input.refreshQueueStatus) identityLower("unknown", "github_refresh_missing");
  else if (input.refreshQueueStatus === "pending")
    identityLower("checking", "github_refresh_pending");
  else if (input.refreshQueueStatus === "claimed")
    identityLower("checking", "github_refresh_in_progress");
  else if (input.refreshQueueStatus === "error") identityLower("unknown", "github_refresh_failed");
  const observedAt = Date.parse(githubIdentity.observedAt);
  if (!Number.isFinite(observedAt)) {
    identityLower("unknown", "github_observation_time_unknown");
  } else if (observedAt > Date.now() + 5_000) {
    identityLower("unknown", "github_observation_future");
  } else if (observedAt < Date.now() - input.requirements.freshnessSeconds * 1000) {
    identityLower("unknown", "github_observation_expired");
  }
  blockers.push(...identityBlockers);

  // Required checks: absent or pending is not success.
  const checks = github.checks;
  if (checks !== "passed") add("github_checks_not_passed");

  // GitHub review requirements.
  const reviews = github.reviews;
  if (reviews !== "passed") add("github_reviews_not_passed");

  // Blocking artifact feedback is independent of GitHub threads: open
  // Wallie-side blocking requests hold delivery regardless of revision.
  const githubThreads = github.threads;
  const wallieThreadBlockers: PrReadinessBlocker[] = [];
  if (input.blockingFeedbackCount > 0)
    wallieThreadBlockers.push({ code: "artifact_blocking_feedback_open" });
  const threads = collapseOutcomes(
    wallieThreadBlockers.length ? ["blocked", githubThreads] : [githubThreads],
  );
  if (githubThreads !== "passed") add("github_threads_not_passed");
  blockers.push(...wallieThreadBlockers);

  // Named validation evidence must be an observed harness receipt for the
  // exact accepted commit; markdown assertions never satisfy a requirement.
  let evidence: PrReadinessDimensionOutcome = "passed";
  if (input.requirements.requiredEvidence.length) {
    const evidenceBlockers: PrReadinessBlocker[] = [];
    const records: ValidationEvidenceRecord[] = input.evidence
      ? storedEvidenceRecordsSchema.parse(input.evidence.records)
      : [];
    const results = evaluateValidationEvidence({
      requiredKeys: input.requirements.requiredEvidence,
      commitSha: input.checkpoint?.outputSha ?? "",
      treeSha: input.evidence?.validationTreeSha ?? "",
      records,
      accessibleAssetKeys: input.evidence?.accessibleAssetKeys ?? new Set<string>(),
    });
    for (const result of results) {
      if (result.status !== "passed")
        evidenceBlockers.push({
          code: EVIDENCE_BLOCKER_CODE[result.status] ?? "evidence_unavailable",
          requirement: result.key,
        });
    }
    evidence = evidenceBlockers.length ? "blocked" : "passed";
    blockers.push(...evidenceBlockers);
  }

  // Mergeability plus draft state: a draft or unmergeable PR is never Ready.
  const mergeabilityBlockers: PrReadinessBlocker[] = [];
  if (github.pr.draft) mergeabilityBlockers.push({ code: "github_pr_draft" });
  if (github.mergeability !== "passed")
    mergeabilityBlockers.push({ code: "github_mergeability_not_passed" });
  const mergeability = collapseOutcomes([
    github.mergeability,
    mergeabilityBlockers.length ? "blocked" : "passed",
  ]);
  blockers.push(...mergeabilityBlockers);

  const dimensions: PrReadinessEvaluation["dimensions"] = {
    githubAccess,
    identity,
    checks,
    reviews,
    threads,
    evidence,
    mergeability,
  };
  const state = combineState(dimensions, github.pr.state);

  const deduped = [
    ...new Map(
      [...blockers, ...github.blockers].map((blocker) => [
        `${blocker.code}:${blocker.requirement ?? ""}`,
        blocker,
      ]),
    ).values(),
  ].slice(0, MAX_BLOCKERS);

  if (state === "ready") {
    return {
      state,
      blockers: [],
      summary: {
        githubAccess: "available",
        checks: "passed",
        reviews: "passed",
        evidence: "passed",
        threads: "passed",
      },
      dimensions,
    };
  }
  return { state, blockers: deduped, summary: null, dimensions };
}

// --- Loading + recording (service) ---

type SessionPolicyRow = {
  pipeline_id: string;
  workspace_id: string;
  policy_revision_id: string;
  requirements: DeliveryRequirements;
};

async function loadSessionPolicy(
  admin: AdminClient,
  sessionId: string,
): Promise<SessionPolicyRow | null> {
  const { data: session, error: sessionError } = await admin
    .from("sessions")
    .select("id, workspace_id, pipeline_id, archived_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw new Error("Delivery session is unavailable.");
  if (!session) return null;
  const { data: policy, error: policyError } = await admin
    .from("delivery_policies")
    .select("current_revision_id")
    .eq("workspace_id", session.workspace_id)
    .eq("pipeline_id", session.pipeline_id)
    .maybeSingle();
  if (policyError) throw new Error("Delivery policy is unavailable.");
  if (!policy) return null;
  const { data: revision, error: revisionError } = await admin
    .from("delivery_policy_revisions")
    .select("id, workspace_id, pipeline_id, requirements")
    .eq("id", policy.current_revision_id)
    .maybeSingle();
  if (revisionError || !revision) throw new Error("Delivery policy is unsupported.");
  const requirements = deliveryRequirementsSchema.safeParse(revision.requirements);
  if (!requirements.success) throw new Error("Delivery policy is unsupported.");
  return {
    pipeline_id: session.pipeline_id,
    workspace_id: session.workspace_id,
    policy_revision_id: revision.id,
    requirements: requirements.data,
  };
}

async function loadEvaluatorInput(
  admin: AdminClient,
  sessionId: string,
): Promise<{ policy: SessionPolicyRow; input: PrReadinessEvaluatorInput } | null> {
  const policy = await loadSessionPolicy(admin, sessionId);
  if (!policy) return null;

  const { data: session, error: sessionError } = await admin
    .from("sessions")
    .select(
      "id, workspace_id, pipeline_id, artifact_review_revision, current_stage_id, archived_at, phase_status",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError || !session) throw new Error("Delivery session is unavailable.");

  const [syncResult, headResult, queueResult, blockingResult] = await Promise.all([
    admin
      .from("session_pr_sync")
      .select("status, current_epoch_id")
      .eq("session_id", sessionId)
      .maybeSingle(),
    admin
      .from("session_git_heads")
      .select("checkpoint_run_id")
      .eq("session_id", sessionId)
      .maybeSingle(),
    admin
      .from("session_pr_refresh_queue")
      .select("status, last_observation_id")
      .eq("session_id", sessionId)
      .maybeSingle(),
    admin
      .from("artifact_review_threads")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("kind", "blocking")
      .eq("status", "open"),
  ]);
  if (syncResult.error || headResult.error || queueResult.error || blockingResult.error)
    throw new Error("PR delivery state is unavailable.");

  const [epochResult, checkpointResult, githubResult] = await Promise.all([
    syncResult.data?.current_epoch_id
      ? admin
          .from("session_pr_epochs")
          .select("id, pr_number")
          .eq("id", syncResult.data.current_epoch_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null as null }),
    headResult.data?.checkpoint_run_id
      ? admin
          .from("session_git_checkpoints")
          .select("run_id, output_sha")
          .eq("run_id", headResult.data.checkpoint_run_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null as null }),
    queueResult.data?.last_observation_id
      ? admin
          .from("session_pr_verification_observations")
          .select(
            "id, workspace_id, session_id, policy_revision_id, repository_id, repository_full_name, pr_epoch_id, pr_number, head_sha, base_sha, checkpoint_run_id, artifact_review_revision, source, payload, observed_at, created_at",
          )
          .eq("id", queueResult.data.last_observation_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null as null }),
  ]);
  if (epochResult.error || checkpointResult.error || githubResult.error)
    throw new Error("PR delivery identity is unavailable.");

  const evidenceRunId = headResult.data?.checkpoint_run_id ?? null;
  const evidenceResult = evidenceRunId
    ? await admin
        .from("session_validation_evidence")
        .select("run_id, commit_sha, validation_tree_sha, records")
        .eq("run_id", evidenceRunId)
        .maybeSingle()
    : { data: null, error: null as null };
  if (evidenceResult.error) throw new Error("Validation evidence is unavailable.");
  const evidenceRow = evidenceResult.data ?? null;
  const parsedRecords = evidenceRow
    ? storedEvidenceRecordsSchema.safeParse(evidenceRow.records)
    : null;
  const accessibleAssetKeys = new Set<string>();
  if (evidenceRunId && parsedRecords?.success) {
    const { data: assets, error: assetError } = await admin
      .from("session_validation_assets")
      .select("evidence_key")
      .eq("run_id", evidenceRunId)
      .limit(1000);
    if (assetError) throw new Error("Validation evidence assets are unavailable.");
    for (const asset of assets ?? []) accessibleAssetKeys.add(asset.evidence_key);
  }

  const githubObservation =
    githubResult.data && githubResult.data.source === "github" ? githubResult.data : null;
  const githubPayload = githubObservation
    ? githubObservationPayloadSchema.safeParse(githubObservation.payload)
    : null;
  // Repository/installation availability for the consumed observation, mirroring
  // the currentness view. A missing repository row is unavailable, not neutral.
  let repository: { archived: boolean; installationSuspended: boolean } | null = null;
  if (githubObservation?.repository_id) {
    const { data: repoRow, error: repoError } = await admin
      .from("github_repositories")
      .select("id, is_archived, github_installation_id")
      .eq("id", githubObservation.repository_id)
      .maybeSingle();
    if (repoError) throw new Error("PR delivery repository is unavailable.");
    if (repoRow) {
      let installationSuspended = false;
      if (repoRow.github_installation_id) {
        const { data: installationRow, error: installationError } = await admin
          .from("github_installations")
          .select("id, suspended")
          .eq("id", repoRow.github_installation_id)
          .maybeSingle();
        if (installationError) throw new Error("PR delivery installation is unavailable.");
        installationSuspended = installationRow?.suspended ?? true;
      }
      repository = { archived: repoRow.is_archived ?? false, installationSuspended };
    }
  }

  return {
    policy,
    input: {
      requirements: policy.requirements,
      github:
        githubObservation && githubPayload?.success
          ? {
              observation: {
                id: githubObservation.id,
                policyRevisionId: githubObservation.policy_revision_id,
                repositoryId: githubObservation.repository_id ?? "",
                repositoryFullName: githubObservation.repository_full_name ?? "",
                prEpochId: githubObservation.pr_epoch_id ?? "",
                prNumber: githubObservation.pr_number ?? 0,
                headSha: githubObservation.head_sha ?? "",
                baseSha: githubObservation.base_sha ?? "",
                checkpointRunId: githubObservation.checkpoint_run_id ?? "",
                artifactReviewRevision: githubObservation.artifact_review_revision,
                observedAt: githubObservation.observed_at,
              },
              payload: githubPayload.data,
            }
          : null,
      refreshQueueStatus: (queueResult.data?.status ??
        null) as PrReadinessEvaluatorInput["refreshQueueStatus"],
      repository,
      checkpoint: checkpointResult.data
        ? { runId: checkpointResult.data.run_id, outputSha: checkpointResult.data.output_sha }
        : null,
      epoch: epochResult.data
        ? { id: epochResult.data.id, prNumber: epochResult.data.pr_number ?? 0 }
        : null,
      syncStatus: syncResult.data?.status ?? null,
      policyRevisionId: policy.policy_revision_id,
      reviewRevision: session.artifact_review_revision,
      evidence:
        parsedRecords?.success && evidenceRow
          ? {
              commitSha: evidenceRow.commit_sha,
              validationTreeSha: evidenceRow.validation_tree_sha,
              records: parsedRecords.data,
              accessibleAssetKeys,
            }
          : null,
      blockingFeedbackCount: blockingResult.count ?? 0,
    },
  };
}

function readinessPayload(input: PrReadinessEvaluatorInput, evaluation: PrReadinessEvaluation) {
  const github = input.github?.observation;
  return {
    version: 1,
    githubAccess: evaluation.dimensions.githubAccess === "passed" ? "available" : "unavailable",
    checks: evaluation.dimensions.checks,
    reviews: evaluation.dimensions.reviews,
    evidence: evaluation.dimensions.evidence,
    threads: evaluation.dimensions.threads,
    mergeability: evaluation.dimensions.mergeability,
    identity: github
      ? {
          repositoryId: github.repositoryId,
          repositoryFullName: github.repositoryFullName,
          prEpochId: github.prEpochId,
          prNumber: github.prNumber,
          headSha: github.headSha,
          baseSha: github.baseSha,
          checkpointRunId: github.checkpointRunId,
          policyRevisionId: github.policyRevisionId,
          artifactReviewRevision: github.artifactReviewRevision,
        }
      : null,
    sourceObservationId: github?.id ?? null,
    summary: evaluation.summary,
  };
}

/** Persist an immutable decision bound to the observed canonical identity. */
export async function recordPrReadinessDecision(
  admin: AdminClient,
  sessionId: string,
  workspaceId: string,
  input: PrReadinessEvaluatorInput,
  evaluation: PrReadinessEvaluation,
): Promise<PrReadinessEvaluation> {
  const github = input.github?.observation;
  if (!github) return evaluation; // Code observations require complete identity.
  const payload = readinessPayload(input, evaluation) as unknown as Json;
  const { data: observation, error: observationError } = await admin.rpc(
    "record_pr_verification_observation",
    {
      p_workspace_id: workspaceId,
      p_session_id: sessionId,
      p_policy_revision_id: github.policyRevisionId,
      p_repository_id: github.repositoryId,
      p_repository_full_name: github.repositoryFullName,
      p_pr_epoch_id: github.prEpochId,
      p_pr_number: github.prNumber,
      p_head_sha: github.headSha,
      p_base_sha: github.baseSha,
      p_checkpoint_run_id: github.checkpointRunId,
      p_artifact_review_revision: github.artifactReviewRevision,
      p_source: "readiness",
      p_payload: payload,
      p_observed_at: new Date().toISOString(),
    },
  );
  if (observationError) throw new Error("PR readiness observation could not be recorded.");
  const { error: resultError } = await admin.rpc("record_pr_verification_result", {
    p_observation_id: (observation as { id: string }).id,
    p_state: evaluation.state,
    p_blockers: evaluation.blockers as unknown as Json,
  });
  if (resultError) throw new Error("PR readiness decision could not be recorded.");
  return evaluation;
}

/** True when the session's current stage is its final selected stage: only final approval delivers. */
async function currentStageIsFinal(admin: AdminClient, sessionId: string): Promise<boolean> {
  const { data: session, error: sessionError } = await admin
    .from("sessions")
    .select("current_stage_id, pipeline_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError || !session) return false;
  const { data: selection, error: selectionError } = await admin
    .from("session_selected_stages")
    .select("stage_id")
    .eq("session_id", sessionId)
    .limit(200);
  if (selectionError || !selection?.length) return false;
  const { data: stages, error: stagesError } = await admin
    .from("pipeline_stages")
    .select("id, position")
    .eq("pipeline_id", session.pipeline_id)
    .in(
      "id",
      selection.map((row) => row.stage_id),
    );
  if (stagesError || !stages?.length) return false;
  const current = stages.find((stage) => stage.id === session.current_stage_id);
  if (!current) return false;
  return stages.every((stage) => stage.position <= current.position);
}

export type SessionPrReadinessOutcome = {
  policy: SessionPolicyRow;
  evaluation: PrReadinessEvaluation;
  finalStage: boolean;
  recorded: boolean;
};

/**
 * Evaluate one session now and persist the decision. The approval path calls
 * this just before `approve_session_stage`, so the gate validates a decision
 * bound to the exact current identity rather than a possibly stale one.
 */
export async function evaluateSessionPrReadiness(
  admin: AdminClient,
  sessionId: string,
  options: { record?: boolean } = {},
): Promise<SessionPrReadinessOutcome | null> {
  const loaded = await loadEvaluatorInput(admin, sessionId);
  if (!loaded) return null;
  const { policy, input } = loaded;
  const evaluation = evaluatePrReadiness(input);
  const record = options.record ?? true;
  // Analysis delivery is explicitly not applicable and never synthesizes a
  // PR. Mid-pipeline approval does not deliver, so only final-stage code
  // sessions persist decisions; the gate itself re-validates currentness.
  const finalStage =
    policy.requirements.deliveryMode === "code" && (await currentStageIsFinal(admin, sessionId));
  if (!finalStage || !record || !input.github) {
    return { policy, evaluation, finalStage, recorded: false };
  }
  await recordPrReadinessDecision(admin, sessionId, policy.workspace_id, input, evaluation);
  return { policy, evaluation, finalStage, recorded: true };
}

/** Keep already-current decisions fresh for display; re-record only when the GitHub observation advanced. */
async function shouldRecordFreshDecision(admin: AdminClient, sessionId: string): Promise<boolean> {
  const { data: latest, error } = await admin
    .from("session_pr_verification_observations")
    .select("id, created_at, source")
    .eq("session_id", sessionId)
    .eq("source", "readiness")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("PR readiness history is unavailable.");
  if (!latest?.length) return true;
  const { data: queue, error: queueError } = await admin
    .from("session_pr_refresh_queue")
    .select("last_observation_id, status")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (queueError) throw new Error("PR refresh queue is unavailable.");
  if (queue?.status !== "current" || !queue.last_observation_id) return false;
  const { data: github, error: githubError } = await admin
    .from("session_pr_verification_observations")
    .select("id, created_at")
    .eq("id", queue.last_observation_id)
    .maybeSingle();
  if (githubError) throw new Error("PR readiness history is unavailable.");
  return Boolean(github && latest[0].created_at <= github.created_at);
}

/**
 * Worker-side readiness drain. Bounded batch of active sessions with a
 * completed GitHub observation. Archived sessions are excluded before the
 * batch limit — their queue rows stay `current` forever with old
 * `updated_at`, so they would permanently occupy the batch and starve active
 * sessions. Already-consumed work (the latest GitHub observation has a newer
 * readiness decision) is skipped without occupying an evaluation slot, so
 * completed history cannot starve active sessions either.
 */
export async function reconcilePrReadiness(
  admin: AdminClient | undefined,
  options: {
    workspaceId?: string;
    limit?: number;
    input?: Record<string, string | undefined>;
  } = {},
): Promise<{ evaluated: number; recorded: number; failed: number }> {
  const client = admin ?? createSupabaseAdminClient(options.input);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 20);
  const result = { evaluated: 0, recorded: 0, failed: 0 };
  // Scan a multiple of the evaluation budget so consumed rows can be skipped
  // without shrinking the actual batch of fresh decisions below the limit.
  const { data: queueRows, error } = await client
    .from("session_pr_refresh_queue")
    .select(
      "session_id, workspace_id, status, last_observation_id, session:sessions!inner(archived_at)",
    )
    .eq("status", "current")
    .not("last_observation_id", "is", null)
    .is("session.archived_at", null)
    .order("updated_at", { ascending: true })
    .limit(limit * 3);
  if (error) throw new Error("PR refresh queue is unavailable.");
  for (const row of queueRows ?? []) {
    if (result.evaluated >= limit) break;
    if (options.workspaceId && row.workspace_id !== options.workspaceId) continue;
    if (!row.last_observation_id) continue;
    try {
      // Only fresh, unconsumed work is evaluated; a skipped row never
      // occupies the batch.
      if (!(await shouldRecordFreshDecision(client, row.session_id))) continue;
      const outcome = await evaluateSessionPrReadiness(client, row.session_id, {
        record: true,
      });
      result.evaluated++;
      if (outcome?.recorded) result.recorded++;
    } catch {
      // A failed evaluation leaves the previous decision; currentness and the
      // delivery gate still fail closed without this decision.
      result.failed++;
    }
  }
  return result;
}
