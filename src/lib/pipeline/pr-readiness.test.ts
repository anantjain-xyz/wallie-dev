import { beforeEach, describe, expect, it, vi } from "vitest";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import type { Tables } from "@/lib/supabase/database.types";

import {
  evaluatePrReadiness,
  evaluateSessionPrReadiness,
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

function evaluatorInput(
  overrides: Partial<PrReadinessEvaluatorInput> = {},
): PrReadinessEvaluatorInput {
  const checkpoint = { runId: "run-1", outputSha: shaB };
  const epoch = { id: "epoch-1", prNumber: 505 };
  return {
    requirements,
    github: {
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
      },
      payload: githubPayload(),
    },
    checkpoint,
    epoch,
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
        github: {
          observation: {
            id: "obs-github",
            policyRevisionId: "policy-1",
            repositoryId: "repo-1",
            repositoryFullName: "acme/app",
            prEpochId: "epoch-1",
            prNumber: 505,
            headSha: shaA,
            baseSha,
            checkpointRunId: "run-1",
            artifactReviewRevision: 3,
          },
          payload: githubPayload({ pr: { ...githubPayload().pr, headSha: shaA } }),
        },
      }),
    );
    expect(evaluation.state).not.toBe("ready");
    expect(evaluation.blockers).toContainEqual({ code: "pr_head_checkpoint_mismatch" });
  });

  it("invalidates a changed policy revision and accepted checkpoint binding", () => {
    const policyChanged = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload(),
        },
        policyRevisionId: "policy-2",
      }),
    );
    expect(policyChanged.state).toBe("unknown");
    expect(policyChanged.blockers).toContainEqual({ code: "policy_revision_changed" });

    const checkpointChanged = evaluatePrReadiness(
      evaluatorInput({
        github: {
          observation: {
            id: "obs-github",
            policyRevisionId: "policy-1",
            repositoryId: "repo-1",
            repositoryFullName: "acme/app",
            prEpochId: "epoch-1",
            prNumber: 505,
            headSha: shaB,
            baseSha,
            checkpointRunId: "run-2",
            artifactReviewRevision: 3,
          },
          payload: githubPayload(),
        },
        checkpoint: { runId: "run-1", outputSha: shaB },
      }),
    );
    expect(checkpointChanged.state).toBe("unknown");
    expect(checkpointChanged.blockers).toContainEqual({ code: "checkpoint_changed" });
  });

  it("invalidates a policy revision or review revision change", () => {
    expect(evaluatePrReadiness(evaluatorInput({ policyRevisionId: "policy-2" })).state).toBe(
      "unknown",
    );
    expect(evaluatePrReadiness(evaluatorInput({ reviewRevision: 4 })).state).toBe("unknown");
    expect(evaluatePrReadiness(evaluatorInput({ reviewRevision: 4 })).blockers).toContainEqual({
      code: "review_revision_changed",
    });
    expect(
      evaluatePrReadiness(evaluatorInput({ policyRevisionId: "policy-2" })).blockers,
    ).toContainEqual({ code: "policy_revision_changed" });
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
      evaluatorInput({
        epoch: { id: "epoch-2", prNumber: 506 },
        github: {
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
          },
          payload: githubPayload(),
        },
      }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "pr_epoch_changed" });
  });

  it.each(["blocked", "checking", "unknown"] as const)(
    "propagates required-check failures as %s with named blockers",
    (checks) => {
      const evaluation = evaluatePrReadiness(
        evaluatorInput({
          github: {
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
            },
            payload: githubPayload({ checks }),
          },
        }),
      );
      expect(evaluation.state).toBe(checks);
      expect(evaluation.blockers).toContainEqual({ code: "github_checks_not_passed" });
    },
  );

  it("blocks unmet GitHub review requirements", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload({
            reviews: "blocked",
            blockers: [{ code: "github_approvals_required" }],
          }),
        },
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
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload({ pr: { ...githubPayload().pr, draft: true } }),
        },
      }),
    );
    expect(evaluation.state).toBe("blocked");
    expect(evaluation.blockers).toContainEqual({ code: "github_pr_draft" });
  });

  it("propagates unknown mergeability as unknown", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload({ mergeability: "unknown" }),
        },
      }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "github_mergeability_not_passed" });
  });

  it("reports merged and closed only from the authoritative PR state", () => {
    const merged = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload({ pr: { ...githubPayload().pr, state: "merged" } }),
        },
      }),
    );
    expect(merged.state).toBe("merged");
    expect(merged.summary).toBeNull();

    const closed = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          payload: githubPayload({ pr: { ...githubPayload().pr, state: "closed" } }),
        },
      }),
    );
    expect(closed.state).toBe("closed");
  });

  it("fails closed on unavailable GitHub access", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        github: {
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
          },
          // The collector only records available access; a fabricated payload
          // with another value still fails closed.
          payload: { ...githubPayload(), githubAccess: "unavailable" as never },
        },
      }),
    );
    expect(evaluation.state).toBe("unknown");
    expect(evaluation.blockers).toContainEqual({ code: "github_access_unavailable" });
  });

  it("deduplicates blockers and keeps ready free of them", () => {
    const evaluation = evaluatePrReadiness(
      evaluatorInput({
        blockingFeedbackCount: 1,
        github: {
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
          },
          payload: githubPayload({
            blockers: [{ code: "github_review_threads_unresolved" }],
            threads: "blocked",
          }),
        },
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
        order: () => typeof builder;
        limit: () => Promise<{ data: unknown; error: null }>;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => unknown;
      } = {
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: async () => ({ data, error: null }),
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve) => resolve({ data, error: null }),
      };
      return builder;
    },
  };
}

function countableTable(count: number) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: async () => ({ count, error: null }),
        }),
      }),
    }),
  };
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
  observed_at: "2026-11-06T00:00:00Z",
  created_at: "2026-11-06T00:00:00Z",
};

describe("session readiness service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without a configured policy so review-only pipelines never gate", async () => {
    const tables = {
      sessions: queryableTable({ id: "sess-1", workspace_id: "ws-1", pipeline_id: "pipe-1" }),
      delivery_policies: queryableTable(null),
    };
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
    const tables = {
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
      session_pr_epochs: queryableTable({ id: "epoch-1", pr_number: 505 }),
      session_git_checkpoints: queryableTable({ run_id: "run-1", output_sha: shaB }),
      session_validation_evidence: queryableTable({
        run_id: "run-1",
        commit_sha: shaB,
        validation_tree_sha: shaC,
        records: evaluatorInput().evidence!.records,
      }),
      session_validation_assets: queryableTable([{ evidence_key: "tests/report" }]),
      session_pr_verification_observations: queryableTable(githubObservationRow),
      session_selected_stages: queryableTable([{ stage_id: "stage-1" }, { stage_id: "stage-2" }]),
      pipeline_stages: queryableTable([
        { id: "stage-1", position: 1 },
        { id: "stage-2", position: 2 },
      ]),
    };
    const admin = buildServiceAdminClient(tables, rpc);
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
    const tables = {
      sessions: queryableTable({
        id: "sess-1",
        workspace_id: "ws-1",
        pipeline_id: "pipe-1",
        artifact_review_revision: 3,
        current_stage_id: "stage-1",
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
      session_pr_epochs: queryableTable({ id: "epoch-1", pr_number: 505 }),
      session_git_checkpoints: queryableTable({ run_id: "run-1", output_sha: shaB }),
      session_validation_evidence: queryableTable(null),
      session_validation_assets: queryableTable([]),
      session_pr_verification_observations: queryableTable(githubObservationRow),
      session_selected_stages: queryableTable([{ stage_id: "stage-1" }, { stage_id: "stage-2" }]),
      pipeline_stages: queryableTable([
        { id: "stage-1", position: 1 },
        { id: "stage-2", position: 2 },
      ]),
    };
    const admin = buildServiceAdminClient(tables, rpc);
    const outcome = await evaluateSessionPrReadiness(admin as never, "sess-1", { record: true });
    expect(outcome?.finalStage).toBe(false);
    expect(outcome?.recorded).toBe(false);
    expect(rpc).not.toHaveBeenCalledWith("record_pr_verification_observation", expect.anything());
  });
});

describe("worker readiness drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips rows without a completed GitHub observation and counts failures", async () => {
    const rpc = vi.fn();
    const tables = {
      session_pr_refresh_queue: queryableTable(null),
    };
    const admin = buildServiceAdminClient(tables, rpc);
    // No 'current' queue rows exist, so nothing is evaluated or recorded.
    const result = await reconcilePrReadiness(admin as never);
    expect(result).toEqual({ evaluated: 0, recorded: 0, failed: 0 });
  });
});
