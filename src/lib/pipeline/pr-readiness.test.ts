import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import type { Tables } from "@/lib/supabase/database.types";
import { BROWSER_CAPTURE_POLICY } from "@/lib/validation-evidence/browser-contract";

import {
  evaluatePrReadiness,
  evaluateSessionPrReadiness,
  loadSessionPrReadinessDetails,
  reconcilePrReadiness,
  storedEvidenceRecordsSchema,
  type GitHubObservationPayload,
  type PrReadinessEvaluatorInput,
} from "./pr-readiness";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);
const baseSha = "0".repeat(40);
const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const assetId = "10000000-0000-4000-8000-000000000003";

const requirements = deliveryRequirementsSchema.parse({
  version: 1,
  deliveryMode: "code",
  requiredChecks: ["CI"],
  minimumApprovals: 1,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: ["tests"],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: true,
});

function githubPayload(
  overrides: Partial<GitHubObservationPayload> = {},
): GitHubObservationPayload {
  return {
    version: 1,
    githubAccess: "available",
    checks: "passed",
    reviews: "passed",
    threads: "passed",
    mergeability: "passed",
    protection: "verified",
    blockers: [],
    pr: {
      number: 505,
      state: "open",
      draft: false,
      headSha: shaB,
      baseSha,
      updatedAt: "2026-11-06T00:00:00Z",
    },
    ...overrides,
  };
}

type ObservationOverrides = Partial<
  NonNullable<PrReadinessEvaluatorInput["github"]>["observation"]
>;

function githubInput(
  observation: ObservationOverrides = {},
  payload: Partial<GitHubObservationPayload> = {},
): NonNullable<PrReadinessEvaluatorInput["github"]> {
  return {
    observation: {
      id: "obs-github",
      policyRevisionId: "policy-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/app",
      prEpochId: "epoch-1",
      prNumber: 505,
      headSha: shaB,
      baseSha,
      checkpointRunId: runId,
      artifactReviewRevision: 3,
      observedAt: new Date().toISOString(),
      ...observation,
    },
    payload: githubPayload(payload),
  };
}

function evaluatorInput(
  overrides: Partial<PrReadinessEvaluatorInput> = {},
): PrReadinessEvaluatorInput {
  return {
    requirements,
    github: githubInput(),
    refreshQueueStatus: "current",
    repository: { archived: false, installationSuspended: false },
    checkpoint: { runId: runId, outputSha: shaB },
    epoch: { id: "epoch-1", prNumber: 505 },
    syncStatus: "synced",
    policyRevisionId: "policy-1",
    reviewRevision: 3,
    evidence: {
      commitSha: shaB,
      validationTreeSha: shaC,
      records: storedEvidenceRecordsSchema.parse([
        {
          key: "tests",
          command: "pnpm test",
          provenance: "harness",
          status: "passed",
          exitCode: 0,
          startedAt: "2026-11-06T00:00:00Z",
          completedAt: "2026-11-06T00:01:00Z",
          commitSha: shaB,
          treeSha: shaC,
          finalCommitSha: shaB,
          finalTreeSha: shaC,
          reportKeys: ["tests/report"],
          missingRequiredReports: [],
        },
      ]),
      accessibleAssetKeys: new Set(["tests/report"]),
    },
    blockingFeedbackCount: 0,
    ...overrides,
  };
}

describe("PR readiness truth table", () => {
  it("treats a missing authoritative GitHub observation as unknown, never success", () => {
    const evaluation = evaluatePrReadiness(evaluatorInput({ github: null }));
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.summary).toBeNull();
    expect(evaluation.blockers).toEqual([{ code: "github_observation_missing" }]);
    expect(Object.values(evaluation.dimensions).every((value) => value !== "passed")).toBe(true);
  });

  it("marks every known dimension passed for the exact current identity as ready", () => {
    const evaluation = evaluatePrReadiness(evaluatorInput());
    expect(evaluation.state).toBe("ready");
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.summary).toEqual({
      githubAccess: "available",
      checks: "passed",
      reviews: "passed",
      evidence: "passed",
      threads: "passed",
    });
  });

  it("blocks a PR head that differs from the accepted checkpoint output", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput({ headSha: shaA }, { pr: { ...githubPayload().pr, headSha: shaA } }),
      }),
    );
    expect(evaluation.state).not.toBe("ready");
    expect(evaluation.blockers).toContainEqual({ code: "pr_head_checkpoint_mismatch" });
  });

  it("invalidates a changed policy revision and accepted checkpoint binding", () => {
    const policyChanged = evaluatePrReadiness(evaluatorInput({ policyRevisionId: "policy-2" }));
    expect(policyChanged.state).toBe("unknown");
    expect(policyChanged.blockers).toContainEqual({ code: "policy_revision_changed" });

    const checkpointChanged = evaluatePrReadiness(
      evaluatorInput({ github: githubInput({ checkpointRunId: "run-2" }) }),
    );
    expect(checkpointChanged.state).toBe("unknown");
    expect(checkpointChanged.blockers).toContainEqual({ code: "checkpoint_changed" });
  });

  it("invalidates a review revision change", () => {
    const evaluation = evaluatePrReadiness(evaluatorInput({ reviewRevision: 4 }));
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "review_revision_changed" });
  });

  it("treats a missing or unsynced canonical PR as unknown/checking", () => {
    expect(evaluatePrReadiness(evaluatorInput({ epoch: null })).state).toBe("unknown");
    expect(evaluatePrReadiness(evaluatorInput({ syncStatus: null })).state).toBe("unknown");
    expect(evaluatePrReadiness(evaluatorInput({ syncStatus: "pending" })).state).toBe("checking");
    expect(evaluatePrReadiness(evaluatorInput({ syncStatus: "conflict" })).state).toBe("checking");
    expect(evaluatePrReadiness(evaluatorInput({ checkpoint: null })).state).toBe("unknown");
  });

  it("invalidates a changed PR epoch identity", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({ epoch: { id: "epoch-2", prNumber: 506 } }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "pr_epoch_changed" });
  });

  it.each(["blocked", "checking", "unknown"] as const)(
    "propagates required-check failures as %s with named blockers",
    (checks) => {
      const evaluation = evaluatePrReadiness(
        evaluatorInput({ github: githubInput({}, { checks }) }),
      );
      expect(evaluation.state).toBe(checks);
      expect(evaluation.blockers).toContainEqual({ code: "github_checks_not_passed" });
    },
  );

  it("blocks unmet GitHub review requirements", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput(
          {},
          {
            reviews: "blocked",
            blockers: [{ code: "github_approvals_required" }],
          },
        ),
      }),
    );
    expect(evaluation.state).toBe("blocked");
    expect(evaluation.blockers).toContainEqual({ code: "github_approvals_required" });
  });

  it("blocks open Wallie blocking feedback independently of GitHub threads", () => {
    const evaluation = evaluatePrReadiness(evaluatorInput({ blockingFeedbackCount: 2 }));
    expect(evaluation.state).toBe("blocked");
    expect(evaluation.blockers).toContainEqual({ code: "artifact_blocking_feedback_open" });
    expect(evaluation.dimensions.threads).toBe("blocked");
  });

  it("blocks missing, stale, failed, and inaccessible required evidence by name", () => {
    const missing = evaluatePrReadiness(evaluatorInput({ evidence: null }));
    expect(missing.state).toBe("blocked");
    expect(missing.blockers).toContainEqual({ code: "evidence_missing", requirement: "tests" });

    const stale = evaluatePrReadiness(
      evaluatorInput({
        evidence: {
          commitSha: shaB,
          validationTreeSha: shaC,
          records: storedEvidenceRecordsSchema.parse([
            {
              key: "tests",
              command: "pnpm test",
              provenance: "harness",
              status: "stale",
              exitCode: 0,
              startedAt: "2026-11-06T00:00:00Z",
              completedAt: "2026-11-06T00:01:00Z",
              commitSha: shaA,
              treeSha: shaC,
              finalCommitSha: shaA,
              finalTreeSha: shaC,
              reportKeys: [],
              missingRequiredReports: [],
            },
          ]),
          accessibleAssetKeys: new Set(),
        },
      }),
    );
    expect(stale.state).toBe("blocked");
    expect(stale.blockers).toContainEqual({ code: "evidence_stale", requirement: "tests" });

    const failed = evaluatePrReadiness(
      evaluatorInput({
        evidence: {
          commitSha: shaB,
          validationTreeSha: shaC,
          records: storedEvidenceRecordsSchema.parse([
            {
              key: "tests",
              command: "pnpm test",
              provenance: "harness",
              status: "passed",
              exitCode: 1,
              startedAt: "2026-11-06T00:00:00Z",
              completedAt: "2026-11-06T00:01:00Z",
              commitSha: shaB,
              treeSha: shaC,
              finalCommitSha: shaB,
              finalTreeSha: shaC,
              reportKeys: [],
              missingRequiredReports: [],
            },
          ]),
          accessibleAssetKeys: new Set(),
        },
      }),
    );
    expect(failed.blockers).toContainEqual({ code: "evidence_failed", requirement: "tests" });

    const unavailable = evaluatePrReadiness(
      evaluatorInput({
        evidence: { ...evaluatorInput().evidence!, accessibleAssetKeys: new Set() },
      }),
    );
    expect(unavailable.blockers).toContainEqual({
      code: "evidence_unavailable",
      requirement: "tests",
    });
  });

  it("passes configured evidence when a current harness receipt is accessible", () => {
    const evaluation = evaluatePrReadiness(evaluatorInput());
    expect(evaluation.dimensions.evidence).toBe("passed");
  });

  it("never marks a draft PR ready", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({ github: githubInput({}, { pr: { ...githubPayload().pr, draft: true } }) }),
    );
    expect(evaluation.state).toBe("blocked");
    expect(evaluation.blockers).toContainEqual({ code: "github_pr_draft" });
  });

  it("propagates unknown mergeability as unknown", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({ github: githubInput({}, { mergeability: "unknown" }) }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "github_mergeability_not_passed" });
  });

  it("reports merged and closed only from the authoritative PR state", () => {
    const merged = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput({}, { pr: { ...githubPayload().pr, state: "merged" } }),
      }),
    );
    expect(merged.state).toBe("merged");
    expect(merged.summary).toBeNull();

    const closed = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput({}, { pr: { ...githubPayload().pr, state: "closed" } }),
      }),
    );
    expect(closed.state).toBe("closed");
  });

  it("fails closed on unavailable GitHub access", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        // The collector only records available access; a fabricated payload
        // with another value still fails closed.
        github: githubInput({}, { githubAccess: "unavailable" as never }),
      }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "github_access_unavailable" });
  });

  it("fails closed on archived repositories and suspended installations", () => {
    const archived = evaluatePrReadiness(
      evaluatorInput({ repository: { archived: true, installationSuspended: false } }),
    );
    expect(archived.state).toBe("unknown");
    expect(archived.blockers).toContainEqual({ code: "github_repository_archived" });

    const suspended = evaluatePrReadiness(
      evaluatorInput({ repository: { archived: false, installationSuspended: true } }),
    );
    expect(suspended.state).toBe("unknown");
    expect(suspended.blockers).toContainEqual({ code: "github_installation_suspended" });

    const unavailable = evaluatePrReadiness(evaluatorInput({ repository: null }));
    expect(unavailable.state).toBe("unknown");
    expect(unavailable.blockers).toContainEqual({ code: "github_repository_unavailable" });
  });

  it("keeps a pending or failed refresh queue from Ready, mirroring the gate", () => {
    const pending = evaluatePrReadiness(evaluatorInput({ refreshQueueStatus: "pending" }));
    expect(pending.state).toBe("checking");
    expect(pending.blockers).toContainEqual({ code: "github_refresh_pending" });

    const claimed = evaluatePrReadiness(evaluatorInput({ refreshQueueStatus: "claimed" }));
    expect(claimed.state).toBe("checking");
    expect(claimed.blockers).toContainEqual({ code: "github_refresh_in_progress" });

    const failed = evaluatePrReadiness(evaluatorInput({ refreshQueueStatus: "error" }));
    expect(failed.state).toBe("unknown");
    expect(failed.blockers).toContainEqual({ code: "github_refresh_failed" });

    const missing = evaluatePrReadiness(evaluatorInput({ refreshQueueStatus: null }));
    expect(missing.state).toBe("unknown");
    expect(missing.blockers).toContainEqual({ code: "github_refresh_missing" });
  });

  it("expires an observation older than the configured freshness window", () => {
    const expired = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput({ observedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }),
      }),
    );
    expect(expired.state).toBe("unknown");
    expect(expired.blockers).toContainEqual({ code: "github_observation_expired" });
    expect(expired.dimensions.identity).toBe("unknown");

    const future = evaluatePrReadiness(
      evaluatorInput({
        github: githubInput({ observedAt: new Date(Date.now() + 60_000).toISOString() }),
      }),
    );
    expect(future.state).toBe("unknown");
    expect(future.blockers).toContainEqual({ code: "github_observation_future" });
  });

  it("deduplicates blockers and keeps ready free of them", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        blockingFeedbackCount: 1,
        github: githubInput(
          {},
          {
            blockers: [{ code: "github_review_threads_unresolved" }],
            threads: "blocked",
          },
        ),
      }),
    );
    const codes = evaluation.blockers.map((blocker) => blocker.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(evaluation.state).toBe("blocked");
  });
});

// --- Service paths ---

type AdminClient = {
  from: (table: string) => unknown;
  rpc: ReturnType<typeof vi.fn>;
  storage: ReturnType<typeof privateStorage>["storage"];
};

const reportBytes = new TextEncoder().encode("tests passed");

function privateStorage(bytes = reportBytes) {
  const download = vi.fn(() => ({
    asStream: async () => ({
      data: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      error: null,
    }),
  }));
  return { storage: { from: vi.fn(() => ({ download })) }, download };
}

function buildServiceAdminClient(
  tables: Record<string, unknown>,
  rpc: ReturnType<typeof vi.fn>,
  storage = privateStorage().storage,
): AdminClient {
  return { from: (name) => tables[name] ?? {}, rpc, storage };
}

function queryableTable(row: unknown) {
  const data = row ?? null;
  return {
    select: () => {
      const builder: {
        eq: () => typeof builder;
        in: () => typeof builder;
        is: () => typeof builder;
        not: () => typeof builder;
        order: () => typeof builder;
        limit: () => Promise<{ data: unknown; error: null }>;
        abortSignal: () => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => unknown;
      } = {
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        not: () => builder,
        order: () => builder,
        abortSignal: () => builder,
        limit: async () => ({ data, error: null }),
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve) => resolve({ data, error: null }),
      };
      return builder;
    },
  };
}

function countableTable(count: number, rows: unknown[] = []) {
  const builder = {
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async () => ({ data: rows, count, error: null })),
  };
  builder.eq.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  return { select: vi.fn(() => builder) };
}

const policyRevisionRow = {
  id: "policy-1",
  workspace_id: workspaceId,
  pipeline_id: "pipe-1",
  revision: 1,
  requirements,
  created_by: "user-1",
  created_at: "2026-11-06T00:00:00Z",
};

const githubObservationRow: Tables<"session_pr_verification_observations"> = {
  id: "obs-github",
  workspace_id: workspaceId,
  session_id: "sess-1",
  policy_revision_id: "policy-1",
  repository_id: "repo-1",
  repository_full_name: "acme/app",
  pr_epoch_id: "epoch-1",
  pr_number: 505,
  head_sha: shaB,
  base_sha: baseSha,
  checkpoint_run_id: runId,
  artifact_review_revision: 3,
  source: "github",
  payload: githubPayload() as unknown as Record<string, never>,
  observed_at: new Date().toISOString(),
  created_at: "2026-11-06T00:00:00Z",
};

const richGithubPayload = {
  ...githubPayload(),
  requiredChecks: [{ context: "CI", appId: null, source: "policy" }],
  branchRules: {
    minimumApprovals: 1,
    codeOwnersRequired: false,
    requireResolvedThreads: true,
    strictChecks: false,
    unsupportedRules: [],
  },
  reviewEvidence: {
    decision: "APPROVED",
    currentHeadApprovals: 1,
    unresolvedThreads: [],
    mergeStateStatus: "CLEAN",
  },
};

const repositoryRow = {
  id: "repo-1",
  full_name: "acme/app",
  html_url: "https://github.com/acme/app",
  repo_id: 123,
  is_archived: false,
  github_installation_id: "inst-1",
  workspace_id: workspaceId,
};

const exactAttempt = {
  run_id: runId,
  workspace_id: workspaceId,
  session_id: "sess-1",
  job_id: "job-1",
  attempt_count: 2,
  repository_id: "repo-1",
};

const reportAsset = {
  id: assetId,
  workspace_id: workspaceId,
  session_id: exactAttempt.session_id,
  run_id: runId,
  evidence_key: "tests/report",
  kind: "report",
  required: true,
  storage_path: `${workspaceId}/${runId}/${assetId}`,
  sha256: createHash("sha256").update(reportBytes).digest("hex"),
  content_type: "text/plain",
  size_bytes: reportBytes.byteLength,
};

const validationPlan = {
  ...exactAttempt,
  commit_sha: shaB,
  validation_tree_sha: shaC,
};

const validationReceipt = {
  ...validationPlan,
  records: evaluatorInput().evidence?.records,
  assets: [
    {
      id: reportAsset.id,
      key: reportAsset.evidence_key,
      kind: reportAsset.kind,
      required: reportAsset.required,
      storagePath: reportAsset.storage_path,
      sha256: reportAsset.sha256,
      contentType: reportAsset.content_type,
      sizeBytes: reportAsset.size_bytes,
    },
  ],
};

function serviceTables(overrides: Record<string, unknown> = {}) {
  return {
    sessions: queryableTable({
      id: "sess-1",
      workspace_id: workspaceId,
      pipeline_id: "pipe-1",
      artifact_review_revision: 3,
      current_stage_id: "stage-2",
    }),
    delivery_policies: queryableTable({ current_revision_id: "policy-1" }),
    delivery_policy_revisions: queryableTable(policyRevisionRow),
    session_pr_sync: queryableTable({ status: "synced", current_epoch_id: "epoch-1" }),
    session_git_heads: queryableTable({ checkpoint_run_id: runId }),
    session_pr_refresh_queue: queryableTable({
      status: "current",
      last_observation_id: "obs-github",
    }),
    artifact_review_threads: countableTable(0),
    session_pr_epochs: queryableTable({
      id: "epoch-1",
      pr_number: 505,
      pr_url: "https://github.com/acme/app/pull/505",
      repository_id: "repo-1",
    }),
    session_git_checkpoints: queryableTable({ ...exactAttempt, output_sha: shaB }),
    session_pr_verification_observations: queryableTable(githubObservationRow),
    github_repositories: queryableTable(repositoryRow),
    github_installations: queryableTable({ id: "inst-1", suspended: false }),
    session_validation_evidence: queryableTable(validationReceipt),
    session_validation_plans: queryableTable(validationPlan),
    session_validation_assets: queryableTable([reportAsset]),
    session_validation_asset_withholdings: queryableTable(null),
    session_browser_asset_withholdings: queryableTable(null),
    session_selected_stages: queryableTable([{ stage_id: "stage-1" }, { stage_id: "stage-2" }]),
    pipeline_stages: queryableTable([
      { id: "stage-1", position: 1 },
      { id: "stage-2", position: 2 },
    ]),
    ...overrides,
  };
}

describe("session readiness service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without a configured policy so review-only pipelines never gate", async () => {
    const tables = serviceTables({ delivery_policies: queryableTable(null) });
    const rpc = vi.fn();
    const admin = buildServiceAdminClient(tables, rpc);
    expect(await evaluateSessionPrReadiness(admin as never, "sess-1")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the admitted delivery revision and final stage despite different live settings", async () => {
    const pipelineId = "10000000-0000-4000-8000-000000000010";
    const firstStage = "10000000-0000-4000-8000-000000000011";
    const lastStage = "10000000-0000-4000-8000-000000000012";
    const policyId = "10000000-0000-4000-8000-000000000013";
    const factoryRevision = "10000000-0000-4000-8000-000000000014";
    const definitionJson = JSON.stringify({
      schemaVersion: 1,
      kind: "serial",
      pipelineId,
      repositoryId: "10000000-0000-4000-8000-000000000015",
      sandboxProvider: "e2b",
      agent: {
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
        concurrencyLimit: 1,
        stallTimeoutMs: 300000,
        maxRetries: 2,
        maxTurns: 5,
      },
      executionPolicyRevisionId: null,
      deliveryPolicyRevisionId: policyId,
      skillIds: [],
      toolIds: [],
      operatingRuleStageIds: [],
      stages: [
        { id: firstStage, slug: "plan", name: "Plan", previousStageIds: [] },
        { id: lastStage, slug: "build", name: "Build", previousStageIds: [] },
      ],
    });
    const forbiddenLiveRead = {
      select: vi.fn(() => {
        throw new Error("Unexpected live read");
      }),
    };
    const tables = serviceTables({
      sessions: queryableTable({
        id: "sess-1",
        workspace_id: workspaceId,
        pipeline_id: pipelineId,
        current_stage_id: lastStage,
        artifact_review_revision: 3,
        execute_pinned_definition: true,
        pinned_delivery_policy_revision_id: policyId,
        factory_definition_revision_id: factoryRevision,
      }),
      delivery_policies: forbiddenLiveRead,
      pipeline_stages: forbiddenLiveRead,
      delivery_policy_revisions: queryableTable({
        ...policyRevisionRow,
        id: policyId,
        pipeline_id: pipelineId,
      }),
      factory_definition_revisions: queryableTable({
        definition_json: definitionJson,
        canonical_digest: createHash("sha256").update(definitionJson).digest("hex"),
      }),
    });
    const admin = buildServiceAdminClient(tables, vi.fn());
    const result = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: false });
    expect(result).toMatchObject({ finalStage: true, policy: { policy_revision_id: policyId } });
    expect(forbiddenLiveRead.select).not.toHaveBeenCalled();
  });

  it("records a ready decision for a final-stage code session through the service RPCs", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: githubObservationRow, error: null })
      .mockResolvedValueOnce({ data: { id: "result-1" }, error: null });
    const admin = buildServiceAdminClient(serviceTables(), rpc);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: true });
    expect(outcome?.finalStage).toBe(true);
    expect(outcome?.evaluation.state).toBe("ready");
    expect(outcome?.recorded).toBe(true);
    expect(rpc).toHaveBeenCalledWith("record_pr_verification_observation", {
      p_workspace_id: workspaceId,
      p_session_id: "sess-1",
      p_policy_revision_id: "policy-1",
      p_repository_id: "repo-1",
      p_repository_full_name: "acme/app",
      p_pr_epoch_id: "epoch-1",
      p_pr_number: 505,
      p_head_sha: shaB,
      p_base_sha: baseSha,
      p_checkpoint_run_id: runId,
      p_artifact_review_revision: 3,
      p_source: "readiness",
      p_payload: expect.objectContaining({ githubAccess: "available" }),
      p_observed_at: expect.any(String),
    });
    expect(rpc).toHaveBeenCalledWith("record_pr_verification_result", {
      p_observation_id: "obs-github",
      p_state: "ready",
      p_blockers: [],
    });
  });

  it("blocks readiness if the private report bytes differ from the immutable digest", async () => {
    const { storage, download } = privateStorage(new TextEncoder().encode("tests failed"));
    const rpc = vi.fn().mockResolvedValue({ data: { id: "result-1" }, error: null });
    const admin = buildServiceAdminClient(serviceTables(), rpc, storage);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1");
    expect(download).toHaveBeenCalledExactlyOnceWith(
      reportAsset.storage_path,
      {},
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(outcome?.evaluation.state).toBe("blocked");
    expect(outcome?.evaluation.blockers).toContainEqual({
      code: "evidence_unavailable",
      requirement: "tests",
    });
    expect(rpc).toHaveBeenCalledWith("record_pr_verification_result", {
      p_observation_id: expect.any(String),
      p_state: "blocked",
      p_blockers: expect.arrayContaining([{ code: "evidence_unavailable", requirement: "tests" }]),
    });
  });

  it.each([
    { run_id: "10000000-0000-4000-8000-000000000004" },
    { attempt_count: exactAttempt.attempt_count + 1 },
    { job_id: "job-2" },
    { repository_id: "repo-2" },
  ])(
    "rejects evidence from a different execution even with the same commit and tree (%j)",
    async (identity) => {
      const { storage, download } = privateStorage();
      const admin = buildServiceAdminClient(
        serviceTables({
          session_validation_evidence: queryableTable({ ...validationReceipt, ...identity }),
        }),
        vi.fn(),
        storage,
      );
      const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: false });
      expect(outcome?.evaluation.blockers).toContainEqual({
        code: "evidence_missing",
        requirement: "tests",
      });
      expect(download).not.toHaveBeenCalled();
    },
  );

  it("reports a stale receipt and skips downloads when the frozen validation tree differs", async () => {
    const { storage, download } = privateStorage();
    const admin = buildServiceAdminClient(
      serviceTables({
        session_validation_plans: queryableTable({ ...validationPlan, validation_tree_sha: shaA }),
      }),
      vi.fn(),
      storage,
    );
    const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
    expect(details?.evaluation.blockers).toContainEqual({
      code: "evidence_stale",
      requirement: "tests",
    });
    expect(details?.evidence?.required).toEqual([{ key: "tests", status: "stale" }]);
    expect(details?.evidence?.validationTreeSha).toBe(shaC);
    expect(download).not.toHaveBeenCalled();
  });

  it("skips bytes when the asset row does not match the receipt manifest", async () => {
    const { storage, download } = privateStorage();
    const admin = buildServiceAdminClient(
      serviceTables({
        session_validation_assets: queryableTable([{ ...reportAsset, sha256: "a".repeat(64) }]),
      }),
      vi.fn(),
      storage,
    );
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: false });
    expect(outcome?.evaluation.blockers).toContainEqual({
      code: "evidence_unavailable",
      requirement: "tests",
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps mid-pipeline approvals ungated and unrecorded", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const tables = serviceTables({
      sessions: queryableTable({
        id: "sess-1",
        workspace_id: workspaceId,
        pipeline_id: "pipe-1",
        artifact_review_revision: 3,
        current_stage_id: "stage-1",
      }),
    });
    const admin = buildServiceAdminClient(tables, rpc);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: true });
    expect(outcome?.finalStage).toBe(false);
    expect(outcome?.recorded).toBe(false);
    expect(rpc).not.toHaveBeenCalledWith("record_pr_verification_observation", expect.anything());
  });

  it("fails closed on an expired consumed observation instead of recording Ready", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "result-1" }, error: null });
    const tables = serviceTables({
      session_pr_verification_observations: queryableTable({
        ...githubObservationRow,
        observed_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      }),
    });
    const admin = buildServiceAdminClient(tables, rpc);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: true });
    expect(outcome?.evaluation.state).toBe("unknown");
    expect(outcome?.evaluation.blockers).toContainEqual({ code: "github_observation_expired" });
    expect(rpc).toHaveBeenCalledWith("record_pr_verification_result", {
      p_observation_id: expect.any(String),
      p_state: "unknown",
      p_blockers: expect.arrayContaining([{ code: "github_observation_expired" }]),
    });
  });

  it("fails closed on an archived repository even with a passing payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "result-1" }, error: null });
    const tables = serviceTables({
      github_repositories: queryableTable({ ...repositoryRow, is_archived: true }),
    });
    const admin = buildServiceAdminClient(tables, rpc);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: true });
    expect(outcome?.evaluation.state).toBe("unknown");
    expect(outcome?.evaluation.blockers).toContainEqual({ code: "github_repository_archived" });
  });
});

describe("review readiness details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the exact source observation, checks, reviews, evidence, and refresh state", async () => {
    const admin = buildServiceAdminClient(
      serviceTables({
        session_pr_verification_observations: queryableTable({
          ...githubObservationRow,
          payload: richGithubPayload as never,
        }),
      }),
      vi.fn(),
    );
    const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
    expect(details?.evaluation.state).toBe("ready");
    expect(details?.finalStage).toBe(true);
    expect(details?.approvalGated).toBe(true);
    expect(details?.sourceObservationId).toBe("obs-github");
    expect(details?.pr).toMatchObject({
      repositoryFullName: "acme/app",
      number: 505,
      url: "https://github.com/acme/app/pull/505",
      headSha: shaB,
      baseSha,
      state: "open",
    });
    expect(details?.checks).toEqual([
      { context: "CI", appId: null, sources: ["policy"], status: "passed" },
    ]);
    expect(details?.review).toMatchObject({
      decision: "APPROVED",
      currentHeadApprovals: 1,
      minimumApprovals: 1,
      unresolvedThreads: 0,
    });
    expect(details?.evidence?.required).toEqual([{ key: "tests", status: "passed" }]);
    expect(details?.evidence?.assets[0]).toMatchObject({
      key: "tests/report",
      kind: "report",
      downloadUrl: `/api/sessions/sess-1/validation-evidence/assets/${assetId}`,
    });
    expect(details?.refresh).toMatchObject({ status: "current", canRefresh: true });
    expect(details?.artifactBlockingCount).toBe(0);
    expect(details?.artifactBlockingTarget).toBeNull();
  });

  it("shows exact browser unavailability while leaving text requirements passing", async () => {
    const browserKey = "browser:screenshot:inbox";
    const check = {
      key: "inbox",
      path: "/fixtures/inbox",
      timeoutSeconds: 20,
      interactions: [],
      regionTestId: "inbox-demo",
      excludedTestIds: [],
      evidence: [
        { kind: "screenshot", required: true },
        { kind: "video", required: false },
      ],
    };
    const records = check.evidence.map(({ kind }) => ({
      key: check.key,
      kind,
      path: check.path,
      policy: BROWSER_CAPTURE_POLICY,
      status: "unavailable",
      reason: "runtime_unavailable",
    }));
    function admin(requiredEvidence: string[]) {
      return buildServiceAdminClient(
        serviceTables({
          delivery_policy_revisions: queryableTable({
            ...policyRevisionRow,
            requirements: { ...requirements, requiredEvidence },
          }),
          session_validation_plans: queryableTable({
            ...validationPlan,
            plan: { version: 2, commands: [], browser: [check] },
          }),
          session_browser_verification_receipts: queryableTable({ records }),
        }),
        vi.fn(),
      );
    }

    const required = await loadSessionPrReadinessDetails(
      admin(["tests", browserKey]) as never,
      "sess-1",
    );
    expect(required?.evaluation.state).toBe("blocked");
    expect(required?.evaluation.blockers).toEqual([
      { code: "evidence_unavailable", requirement: browserKey },
    ]);
    expect(required?.evidence?.required).toEqual([
      { key: "tests", status: "passed" },
      { key: browserKey, status: "unavailable" },
    ]);

    const textOnly = await loadSessionPrReadinessDetails(admin(["tests"]) as never, "sess-1");
    expect(textOnly?.evaluation.state).toBe("ready");
  });

  it.each(["screenshot", "video"] as const)("verifies %s readiness", async (kind) => {
    const visualKey = `browser:${kind}:inbox`;
    const browserSessionId = "10000000-0000-4000-8000-000000000006";
    const extension = kind === "video" ? "webm" : "png";
    const contentType = kind === "video" ? "video/webm" : "image/png";
    const bytes =
      kind === "video"
        ? Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(40)])
        : Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC",
            "base64",
          );
    const time = {
      startedAt: "2026-11-06T00:00:00.000Z",
      completedAt: "2026-11-06T00:00:01.000Z",
    };
    const timeline = { durationMs: 500, widthPx: 240, heightPx: 160, frameOffsetsMs: [0] };
    const browserAsset = {
      id: assetId,
      run_id: runId,
      session_id: browserSessionId,
      workspace_id: workspaceId,
      storage_path: `${workspaceId}/${runId}/browser/${assetId}.${extension}`,
      content_type: contentType,
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(kind === "video"
        ? {
            duration_ms: timeline.durationMs,
            width_px: timeline.widthPx,
            height_px: timeline.heightPx,
            frame_offsets_ms: timeline.frameOffsetsMs,
            capture_started_at: time.startedAt,
            capture_completed_at: time.completedAt,
          }
        : {}),
    };
    const check = {
      key: "inbox",
      path: "/fixtures/inbox",
      timeoutSeconds: 20,
      interactions: [],
      regionTestId: "inbox",
      excludedTestIds: [],
      evidence: [{ kind, required: true }],
    };

    const tables = serviceTables({
      session_git_checkpoints: queryableTable({
        ...exactAttempt,
        session_id: browserSessionId,
        output_sha: shaB,
      }),
      session_validation_evidence: queryableTable(null),
      delivery_policy_revisions: queryableTable({
        ...policyRevisionRow,
        requirements: { ...requirements, requiredEvidence: [visualKey] },
      }),
      session_validation_plans: queryableTable({
        ...validationPlan,
        session_id: browserSessionId,
        plan: { version: 2, commands: [], browser: [check] },
      }),
      session_browser_verification_receipts: queryableTable({
        records: [
          {
            key: check.key,
            kind,
            ...(kind === "video" ? time : {}),
            path: check.path,
            policy: BROWSER_CAPTURE_POLICY,
            status: "captured",
            browserSessionId: "10000000-0000-4000-8000-000000000123",
            manifest: {
              assetId,
              sha256: browserAsset.sha256,
              sizeBytes: bytes.byteLength,
              contentType,
              ...(kind === "video" ? timeline : {}),
            },
          },
        ],
      }),
      session_browser_verification_assets: queryableTable([browserAsset]),
    });
    const ready = await loadSessionPrReadinessDetails(
      buildServiceAdminClient(tables, vi.fn(), privateStorage(bytes).storage) as never,
      browserSessionId,
    );
    expect(ready?.evaluation.state).toBe("ready");
    expect(ready?.evidence?.required).toEqual([{ key: visualKey, status: "passed" }]);

    const pendingRemoval = privateStorage(bytes);
    const withheld = await loadSessionPrReadinessDetails(
      buildServiceAdminClient(
        {
          ...tables,
          session_browser_asset_withholdings: queryableTable({
            asset_id: assetId,
            workspace_id: workspaceId,
            session_id: browserSessionId,
            run_id: runId,
            state: "erased",
            recorded_at: "2026-11-06T00:02:00.000Z",
            purged_at: null,
          }),
        },
        vi.fn(),
        pendingRemoval.storage,
      ) as never,
      browserSessionId,
    );
    expect(withheld?.evaluation.state).toBe("blocked");
    expect(withheld?.evidence?.required).toEqual([{ key: visualKey, status: "unavailable" }]);
    expect(withheld?.evaluation.blockers).toEqual([
      { code: "evidence_unavailable", requirement: visualKey },
    ]);
    expect(pendingRemoval.download).not.toHaveBeenCalled();

    const tampered = Buffer.from(bytes);
    tampered[30] ^= 0xff;
    const blocked = await loadSessionPrReadinessDetails(
      buildServiceAdminClient(tables, vi.fn(), privateStorage(tampered).storage) as never,
      browserSessionId,
    );
    expect(blocked?.evaluation.state).toBe("blocked");
    expect(blocked?.evaluation.blockers).toEqual([
      { code: "evidence_unavailable", requirement: visualKey },
    ]);
    if (kind === "video") {
      const mismatchedTables = {
        ...tables,
        session_browser_verification_assets: queryableTable([{ ...browserAsset, width_px: 242 }]),
      };
      const mismatched = await loadSessionPrReadinessDetails(
        buildServiceAdminClient(mismatchedTables, vi.fn(), privateStorage(bytes).storage) as never,
        browserSessionId,
      );
      expect(mismatched?.evaluation.blockers).toEqual([
        { code: "evidence_unavailable", requirement: visualKey },
      ]);
    }
  });

  it.each(["plan", "deleted-stage"])(
    "targets session-wide blocking feedback on a historical %s artifact",
    async (stageSlug) => {
      const threads = countableTable(3, [
        {
          id: "thread-old",
          artifact_id: "artifact-old",
          artifact_version: 1,
          stage_slug: stageSlug,
        },
      ]);
      const admin = buildServiceAdminClient(
        serviceTables({ artifact_review_threads: threads }),
        vi.fn(),
      );
      const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
      expect(details?.artifactBlockingCount).toBe(3);
      expect(details?.artifactBlockingTarget).toEqual({
        threadId: "thread-old",
        artifactId: "artifact-old",
        artifactVersion: 1,
        stageSlug,
      });
      expect(details?.evaluation.blockers).toContainEqual({
        code: "artifact_blocking_feedback_open",
      });
      expect(threads.select).toHaveBeenCalledWith("id, artifact_id, artifact_version, stage_slug", {
        count: "exact",
      });
      const query = threads.select.mock.results[0]!.value;
      expect(query.eq.mock.calls).toEqual([
        ["workspace_id", workspaceId],
        ["session_id", "sess-1"],
        ["kind", "blocking"],
        ["status", "open"],
      ]);
      expect(query.order.mock.calls).toEqual([
        ["created_at", { ascending: true }],
        ["id", { ascending: true }],
      ]);
      expect(query.limit).toHaveBeenCalledWith(1);
    },
  );

  it("withholds predecessor observation detail after the canonical PR epoch changes", async () => {
    const admin = buildServiceAdminClient(
      serviceTables({
        session_pr_sync: queryableTable({
          status: "synced",
          current_epoch_id: "epoch-2",
        }),
        session_pr_epochs: queryableTable({
          id: "epoch-2",
          pr_number: 600,
          pr_url: "https://github.com/acme/app/pull/600",
          repository_id: "repo-1",
        }),
        session_pr_verification_observations: queryableTable({
          ...githubObservationRow,
          payload: {
            ...richGithubPayload,
            pr: { ...richGithubPayload.pr, state: "merged" },
          } as never,
        }),
      }),
      vi.fn(),
    );
    const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
    expect(details?.observationStale).toBe(true);
    expect(details?.evaluation.state).toBe("unknown");
    expect(details?.evaluation.blockers).toContainEqual({ code: "pr_epoch_changed" });
    expect(details?.pr).toMatchObject({
      number: 600,
      url: "https://github.com/acme/app/pull/600",
      headSha: null,
      baseSha: null,
      observedAt: null,
    });
    expect(details?.checks).toEqual([
      { context: "CI", appId: null, sources: ["policy"], status: "unknown" },
    ]);
    expect(details?.review).toBeNull();
    expect(details?.sourceObservationId).toBeNull();
  });

  it("labels a changed head as blocked and keeps the observed head visible", async () => {
    const admin = buildServiceAdminClient(
      serviceTables({
        session_pr_verification_observations: queryableTable({
          ...githubObservationRow,
          head_sha: shaC,
          payload: {
            ...richGithubPayload,
            pr: { ...richGithubPayload.pr, headSha: shaC },
          } as never,
        }),
      }),
      vi.fn(),
    );
    const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
    expect(details?.evaluation.state).toBe("blocked");
    expect(details?.evaluation.blockers).toContainEqual({
      code: "pr_head_checkpoint_mismatch",
    });
    expect(details?.pr?.headSha).toBe(shaC);
  });

  it("reports failed required checks and missing evidence without inventing success", async () => {
    const admin = buildServiceAdminClient(
      serviceTables({
        session_pr_verification_observations: queryableTable({
          ...githubObservationRow,
          payload: {
            ...richGithubPayload,
            checks: "blocked",
            blockers: [
              { code: "github_required_check_failed", requirement: "CI" },
              { code: "github_required_check_pending", requirement: "ci-extra" },
            ],
            requiredChecks: [
              { context: "CI", appId: null, source: "policy" },
              { context: "ci-extra", appId: null, source: "ruleset" },
            ],
          } as never,
        }),
        session_validation_evidence: queryableTable(null),
      }),
      vi.fn(),
    );
    const details = await loadSessionPrReadinessDetails(admin as never, "sess-1");
    expect(details?.evaluation.state).toBe("blocked");
    expect(details?.checks).toEqual([
      { context: "CI", appId: null, sources: ["policy"], status: "failed" },
      { context: "ci-extra", appId: null, sources: ["ruleset"], status: "pending" },
    ]);
    expect(details?.evidence?.required).toEqual([{ key: "tests", status: "missing" }]);
    expect(details?.evidence?.records).toEqual([]);
  });

  it("returns null when the pipeline has no delivery policy", async () => {
    const admin = buildServiceAdminClient(
      serviceTables({ delivery_policies: queryableTable(null) }),
      vi.fn(),
    );
    expect(await loadSessionPrReadinessDetails(admin as never, "sess-1")).toBeNull();
  });
});

describe("worker readiness drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters archived sessions before the batch limit so completed history cannot starve active sessions", async () => {
    const filters: Array<{ kind: string; column: string; value: unknown }> = [];
    let selectColumns = "";
    const builder = {
      eq: (column: string, value: unknown) => {
        filters.push({ kind: "eq", column, value });
        return builder;
      },
      not: (column: string, _operator: string, value: unknown) => {
        filters.push({ kind: "not", column, value });
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push({ kind: "is", column, value });
        return builder;
      },
      order: () => builder,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: [], error: null }),
    };
    const rpc = vi.fn();
    const admin = buildServiceAdminClient(
      {
        session_pr_refresh_queue: {
          select: (columns: string) => {
            selectColumns = columns;
            return builder;
          },
        },
      },
      rpc,
    );
    const result = await reconcilePrReadiness(admin as never);
    expect(result).toEqual({ evaluated: 0, recorded: 0, failed: 0 });
    expect(selectColumns).toContain("sessions!inner(archived_at)");
    expect(filters).toContainEqual({ kind: "eq", column: "status", value: "current" });
    expect(filters).toContainEqual({ kind: "not", column: "last_observation_id", value: null });
    expect(filters).toContainEqual({ kind: "is", column: "session.archived_at", value: null });
  });

  it("skips already-consumed work without occupying the evaluation budget", async () => {
    const rpc = vi.fn();
    // The latest readiness decision is newer than the consumed GitHub
    // observation, so the drain skips this session without evaluating.
    let mode: "readiness" | "byId" | null = null;
    const observationsBuilder = {
      eq: (column: string) => {
        if (column === "source") mode = "readiness";
        if (column === "id") mode = "byId";
        return observationsBuilder;
      },
      order: () => observationsBuilder,
      limit: async () => ({
        data:
          mode === "readiness"
            ? [{ id: "obs-ready", created_at: "2026-11-06T01:00:00Z", source: "readiness" }]
            : null,
        error: null,
      }),
      maybeSingle: async () => ({
        data: mode === "byId" ? { id: "obs-github", created_at: "2026-11-06T00:00:00Z" } : null,
        error: null,
      }),
    };
    const tables = {
      session_pr_refresh_queue: (() => {
        const queueRow = {
          session_id: "sess-active",
          workspace_id: workspaceId,
          status: "current",
          last_observation_id: "obs-github",
          session: { archived_at: null },
        };
        const queueBuilder = {
          eq: () => queueBuilder,
          not: () => queueBuilder,
          is: () => queueBuilder,
          order: () => queueBuilder,
          limit: async () => ({ data: [queueRow], error: null }),
          maybeSingle: async () => ({ data: queueRow, error: null }),
        };
        return { select: () => queueBuilder };
      })(),
      session_pr_verification_observations: { select: () => observationsBuilder },
    };
    const admin = buildServiceAdminClient(tables, rpc);
    const result = await reconcilePrReadiness(admin as never);
    expect(result).toEqual({ evaluated: 0, recorded: 0, failed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
