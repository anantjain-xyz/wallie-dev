import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { observeWorkflowCheckpoint, observeWorkflowHumanApproval } from "./observe-evidence";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const factoryId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
const jobId = "10000000-0000-4000-8000-000000000005";
const repositoryId = "10000000-0000-4000-8000-000000000006";
const stageId = "10000000-0000-4000-8000-000000000007";
const nextStageId = "10000000-0000-4000-8000-000000000008";
const revisionId = "10000000-0000-4000-8000-000000000009";
const artifactId = "10000000-0000-4000-8000-000000000010";
const completionId = "10000000-0000-4000-8000-000000000011";
const approvalId = "10000000-0000-4000-8000-000000000012";
const reviewerId = "10000000-0000-4000-8000-000000000013";
const pipelineId = "10000000-0000-4000-8000-000000000014";
const commitSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const artifact = "Review the exact source.";
const artifactDigest = createHash("sha256").update(artifact, "utf8").digest("hex");
const retainedRef = "refs/wallie/checkpoints/" + runId + "/" + commitSha;
const pin = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_root_session_id: sessionId,
  p_expected_generation: 3,
  p_ownership_token: "10000000-0000-4000-8000-000000000015",
};
const target = { sessionId, jobId, attemptCount: 2, runId, repositoryId, commitSha };
const gate = {
  sessionId,
  stageId,
  artifactId,
  artifactVersion: 4,
  artifactDigest,
  anyoneCanApprove: false,
  approverMemberIds: [reviewerId],
};
const scope = { workspace_id: workspaceId, session_id: sessionId };
const attempt = { ...scope, run_id: runId, job_id: jobId, attempt_count: 2 };
const root = {
  id: sessionId,
  workspace_id: workspaceId,
  factory_id: factoryId,
  archived_at: null,
  current_stage_id: nextStageId,
  current_artifact_id: null,
  current_artifact_version: 0,
  phase_status: "in_progress",
  factory_definition_revision_id: revisionId,
  execute_pinned_definition: true,
};
const source = {
  ...attempt,
  repository_id: repositoryId,
  repository_full_name: "wallie/fixture",
  base_sha: baseSha,
  head_sha: commitSha,
};
const publication = {
  ...attempt,
  retained_ref: retainedRef,
  remote_verified_ref: retainedRef,
  remote_verified_sha: commitSha,
  remote_verified_at: "2026-11-22T22:00:00.000Z",
  deadline_at: "2099-11-22T22:00:00.000Z",
  adopted_at: "2026-11-22T22:00:01.000Z",
  status: "adopted",
  artifact_id: artifactId,
};
const checkpoint = {
  ...attempt,
  repository_id: repositoryId,
  repository_full_name: source.repository_full_name,
  input_sha: baseSha,
  output_sha: commitSha,
  output_ref: retainedRef,
  output_kind: "code",
  artifact_id: artifactId,
};
const approval = {
  ...scope,
  stage_id: stageId,
  id: approvalId,
  completion_id: completionId,
  artifact_id: artifactId,
  artifact_version: gate.artifactVersion,
  artifact_digest: artifactDigest,
};
const { anyoneCanApprove, approverMemberIds } = gate;
const definition = JSON.stringify({
  schemaVersion: 1,
  kind: "serial",
  pipelineId,
  repositoryId,
  sandboxProvider: "vercel",
  agent: {
    provider: "claude_code",
    model: "claude-sonnet-4-6",
    effort: "high",
    concurrencyLimit: 2,
    stallTimeoutMs: 90_000,
    maxRetries: 1,
    maxTurns: 12,
  },
  executionPolicyRevisionId: null,
  deliveryPolicyRevisionId: null,
  skillIds: [],
  toolIds: [],
  operatingRuleStageIds: [],
  stages: [
    {
      id: stageId,
      slug: "review",
      name: "Review",
      previousStageIds: [],
      anyoneCanApprove,
      approverMemberIds,
    },
    { id: nextStageId, slug: "release", name: "Release", previousStageIds: [stageId] },
  ],
});

function fixtureAdmin(overrides: Record<string, unknown> = {}) {
  const tables: Record<string, unknown> = {
    sessions: root,
    session_checkpoint_publications: publication,
    session_source_deliveries: source,
    session_git_checkpoints: checkpoint,
    factory_definition_revisions: {
      definition_json: definition,
      canonical_digest: createHash("sha256").update(definition, "utf8").digest("hex"),
    },
    session_phase_completions: { ...scope, id: completionId, stage_id: stageId },
    session_stage_approval_receipts: approval,
    session_artifacts: {
      ...scope,
      id: artifactId,
      stage_id: stageId,
      version: gate.artifactVersion,
      artifact_json: artifact,
    },
    artifact_review_threads: null,
    ...overrides,
  };
  const from = vi.fn((table: string) => {
    if (!Object.hasOwn(tables, table)) throw new Error("Unknown table " + table);
    const filters = new Map<string, unknown>();
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.set(column, value);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      abortSignal: vi.fn(() => query),
      maybeSingle: async () => {
        const fixture = tables[table];
        const data = Array.isArray(fixture)
          ? (fixture.find((row) => [...filters].every(([key, value]) => row[key] === value)) ??
            null)
          : fixture;
        return { data, error: null };
      },
    };
    return query;
  });
  const rpc = vi.fn();
  return { admin: { from, rpc } as never, from, rpc };
}

describe("workflow checkpoint evidence", () => {
  it("observes the adopted exact publication without issuing a remote write", async () => {
    const { admin, rpc } = fixtureAdmin();
    await expect(observeWorkflowCheckpoint({ admin, pin, target })).resolves.toEqual({
      status: "passed",
      receiptRef: runId,
      artifactId,
      commitSha,
      retainedRef,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hands back only the original durable intent while publication is pending", async () => {
    const { admin, from, rpc } = fixtureAdmin({
      session_checkpoint_publications: {
        ...publication,
        status: "claimed",
        remote_verified_ref: null,
        remote_verified_sha: null,
        remote_verified_at: null,
        adopted_at: null,
        artifact_id: null,
      },
    });
    await expect(observeWorkflowCheckpoint({ admin, pin, target })).resolves.toEqual({
      status: "pending",
      code: "checkpoint_pending",
      recoverableRunId: runId,
    });
    expect(from).not.toHaveBeenCalledWith("session_git_checkpoints");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts unchanged no-code output without pretending to have a new retained ref", async () => {
    const { admin } = fixtureAdmin({
      session_source_deliveries: { ...source, base_sha: commitSha },
      session_git_checkpoints: {
        ...checkpoint,
        input_sha: commitSha,
        output_ref: null,
        output_kind: "no-code",
      },
      session_checkpoint_publications: {
        ...publication,
        retained_ref: null,
        remote_verified_ref: null,
        remote_verified_sha: null,
        remote_verified_at: null,
      },
    });
    await expect(observeWorkflowCheckpoint({ admin, pin, target })).resolves.toMatchObject({
      status: "passed",
      retainedRef: null,
    });
  });

  it.each([
    { session_source_deliveries: { ...source, repository_id: nextStageId } },
    { session_source_deliveries: { ...source, head_sha: baseSha } },
    { session_checkpoint_publications: { ...publication, attempt_count: 1 } },
    { session_checkpoint_publications: { ...publication, remote_verified_sha: baseSha } },
    {
      session_checkpoint_publications: {
        ...publication,
        status: "pending",
        deadline_at: "2000-01-01T00:00:00Z",
      },
    },
    { session_git_checkpoints: { ...checkpoint, artifact_id: nextStageId } },
  ])("rejects contradictory checkpoint evidence %j", async (overrides) => {
    const { admin } = fixtureAdmin(overrides);
    await expect(observeWorkflowCheckpoint({ admin, pin, target })).resolves.toEqual({
      status: "blocked",
      code: "checkpoint_unavailable",
    });
  });
});

describe("workflow human approval evidence", () => {
  it("accepts a prior stage's exact surviving completion and approval", async () => {
    const { admin, rpc } = fixtureAdmin();
    await expect(observeWorkflowHumanApproval({ admin, pin, target: gate })).resolves.toEqual({
      status: "passed",
      receiptRef: approvalId,
      completionId,
      artifactDigest,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the observer deadline to read the pinned approval policy", async () => {
    const { admin, from } = fixtureAdmin();
    const signal = new AbortController().signal;

    await expect(
      observeWorkflowHumanApproval({ admin, pin, target: gate, signal }),
    ).resolves.toMatchObject({ status: "passed" });
    const revisionRead = from.mock.calls.findIndex(
      ([table]) => table === "factory_definition_revisions",
    );
    expect(from.mock.results[revisionRead]?.value?.abortSignal).toHaveBeenCalledExactlyOnceWith(
      signal,
    );
  });

  it("accepts final approval when the completed stage remains selected", async () => {
    const { admin } = fixtureAdmin({
      sessions: {
        ...root,
        current_stage_id: stageId,
        current_artifact_id: artifactId,
        current_artifact_version: gate.artifactVersion,
        phase_status: "approved",
        archived_at: "2026-11-22T22:00:01.000Z",
      },
    });
    await expect(observeWorkflowHumanApproval({ admin, pin, target: gate })).resolves.toMatchObject(
      {
        status: "passed",
        receiptRef: approvalId,
      },
    );
  });

  it("waits for an exact review even before a completion or receipt exists", async () => {
    const { admin, from } = fixtureAdmin({
      sessions: {
        ...root,
        current_stage_id: stageId,
        current_artifact_id: artifactId,
        current_artifact_version: gate.artifactVersion,
        phase_status: "awaiting_review",
      },
      session_phase_completions: null,
      session_stage_approval_receipts: null,
    });
    await expect(observeWorkflowHumanApproval({ admin, pin, target: gate })).resolves.toEqual({
      status: "pending",
      code: "approval_pending",
    });
    expect(from).not.toHaveBeenCalledWith("session_stage_approval_receipts");
  });

  it("rejects a gate policy different from the pinned stage", async () => {
    const { admin, from } = fixtureAdmin();
    await expect(
      observeWorkflowHumanApproval({
        admin,
        pin,
        target: { ...gate, approverMemberIds: [] },
      }),
    ).resolves.toEqual({ status: "blocked", code: "approval_blocked" });
    expect(from).not.toHaveBeenCalledWith("session_stage_approval_receipts");
  });

  it("limits blocking review threads to the exact session", async () => {
    const openBlockingThread = {
      id: "blocking",
      workspace_id: pin.p_workspace_id,
      session_id: gate.sessionId,
      kind: "blocking",
      status: "open",
    };
    const { admin: otherSession } = fixtureAdmin({
      artifact_review_threads: [{ ...openBlockingThread, session_id: nextStageId }],
    });
    await expect(
      observeWorkflowHumanApproval({ admin: otherSession, pin, target: gate }),
    ).resolves.toMatchObject({ status: "passed" });

    const { admin: sameSession } = fixtureAdmin({
      artifact_review_threads: [openBlockingThread],
    });
    await expect(
      observeWorkflowHumanApproval({ admin: sameSession, pin, target: gate }),
    ).resolves.toEqual({ status: "blocked", code: "approval_blocked" });
  });

  it.each([
    { session_phase_completions: null },
    { session_stage_approval_receipts: { ...approval, artifact_version: 3 } },
    { session_stage_approval_receipts: { ...approval, completion_id: nextStageId } },
    {
      session_artifacts: {
        ...scope,
        id: artifactId,
        stage_id: stageId,
        version: gate.artifactVersion,
        artifact_json: "changed",
      },
    },
  ])("rejects stale or unavailable approval evidence %j", async (overrides) => {
    const { admin } = fixtureAdmin(overrides);
    await expect(observeWorkflowHumanApproval({ admin, pin, target: gate })).resolves.toEqual({
      status: "blocked",
      code: "approval_blocked",
    });
  });
});
