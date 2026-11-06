import { beforeEach, describe, expect, it, vi } from "vitest";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import type { Tables } from "@/lib/supabase/database.types";

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
      checkpointRunId: "run-1",
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
    checkpoint: { runId: "run-1", outputSha: shaB },
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
};

function buildServiceAdminClient(tables: Record<string, unknown>, rpc: ReturnType<typeof vi.fn>) {
  return { from: (name: string) => tables[name] ?? {}, rpc } as unknown as AdminClient & {
    rpc: ReturnType<typeof vi.fn>;
  };
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
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => unknown;
      } = {
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        not: () => builder,
        order: () => builder,
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
  workspace_id: "ws-1",
  pipeline_id: "pipe-1",
  revision: 1,
  requirements,
  created_by: "user-1",
  created_at: "2026-11-06T00:00:00Z",
};

const githubObservationRow: Tables<"session_pr_verification_observations"> = {
  id: "obs-github",
  workspace_id: "ws-1",
  session_id: "sess-1",
  policy_revision_id: "policy-1",
  repository_id: "repo-1",
  repository_full_name: "acme/app",
  pr_epoch_id: "epoch-1",
  pr_number: 505,
  head_sha: shaB,
  base_sha: baseSha,
  checkpoint_run_id: "run-1",
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
  workspace_id: "ws-1",
};

function serviceTables(overrides: Record<string, unknown> = {}) {
  return {
    sessions: queryableTable({
      id: "sess-1",
      workspace_id: "ws-1",
      pipeline_id: "pipe-1",
      artifact_review_revision: 3,
      current_stage_id: "stage-2",
    }),
    delivery_policies: queryableTable({ current_revision_id: "policy-1" }),
    delivery_policy_revisions: queryableTable(policyRevisionRow),
    session_pr_sync: queryableTable({ status: "synced", current_epoch_id: "epoch-1" }),
    session_git_heads: queryableTable({ checkpoint_run_id: "run-1" }),
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
    session_git_checkpoints: queryableTable({ run_id: "run-1", output_sha: shaB }),
    session_pr_verification_observations: queryableTable(githubObservationRow),
    github_repositories: queryableTable(repositoryRow),
    github_installations: queryableTable({ id: "inst-1", suspended: false }),
    session_validation_evidence: queryableTable({
      run_id: "run-1",
      commit_sha: shaB,
      validation_tree_sha: shaC,
      records: evaluatorInput().evidence!.records,
    }),
    session_validation_assets: queryableTable([
      {
        id: "asset-1",
        evidence_key: "tests/report",
        kind: "report",
        required: true,
        size_bytes: 128,
      },
    ]),
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
      p_workspace_id: "ws-1",
      p_session_id: "sess-1",
      p_policy_revision_id: "policy-1",
      p_repository_id: "repo-1",
      p_repository_full_name: "acme/app",
      p_pr_epoch_id: "epoch-1",
      p_pr_number: 505,
      p_head_sha: shaB,
      p_base_sha: baseSha,
      p_checkpoint_run_id: "run-1",
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

  it("keeps mid-pipeline approvals ungated and unrecorded", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const tables = serviceTables({
      sessions: queryableTable({
        id: "sess-1",
        workspace_id: "ws-1",
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
      downloadUrl: "/api/sessions/sess-1/validation-evidence/assets/asset-1",
    });
    expect(details?.refresh).toMatchObject({ status: "current", canRefresh: true });
    expect(details?.artifactBlockingCount).toBe(0);
    expect(details?.artifactBlockingTarget).toBeNull();
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
        ["workspace_id", "ws-1"],
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
          workspace_id: "ws-1",
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
