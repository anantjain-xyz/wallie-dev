import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  capture: vi.fn(),
  checkpoint: vi.fn(),
  pinPlan: vi.fn(),
  readIdentity: vi.fn(),
}));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: mocks.upload }));
vi.mock("./capture", () => ({
  captureValidationEvidence: mocks.capture,
  readValidationIdentity: mocks.readIdentity,
}));
vi.mock("./plan", () => ({ pinValidationPlan: mocks.pinPlan }));
vi.mock("@/lib/pipeline/source-checkpoint", () => ({ captureSourceCheckpoint: mocks.checkpoint }));
import {
  persistValidationEvidence,
  shouldCaptureValidationEvidence,
  validateCheckpoint,
} from "./service";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const record = () => ({
  key: "unit",
  command: "pnpm test",
  provenance: "harness" as const,
  status: "passed" as const,
  exitCode: 0,
  startedAt: "2026-11-06T01:00:00Z",
  completedAt: "2026-11-06T01:01:00Z",
  commitSha: sha,
  treeSha: tree,
  finalCommitSha: sha,
  finalTreeSha: tree,
  reportKeys: ["unit/report"],
  missingRequiredReports: [],
});
const evidence = () => ({
  commitSha: sha,
  treeSha: tree,
  records: [record()],
  assets: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      key: "unit/report",
      kind: "report" as const,
      required: true,
      bytes: Buffer.from("[redacted] test passed"),
      contentType: "text/plain" as const,
    },
  ],
});
function adminMock() {
  const rpc = vi.fn().mockReturnValue(Promise.resolve({ data: {}, error: null }));
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn(),
  };
  return { rpc, from: vi.fn(() => query), query };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockResolvedValue({ error: null });
  mocks.capture.mockResolvedValue(evidence());
  mocks.pinPlan.mockResolvedValue({ plan: { version: 1, commands: [] } });
  mocks.readIdentity.mockResolvedValue({ clean: true, commitSha: sha, treeSha: tree });
  mocks.checkpoint.mockResolvedValue({ kind: "unchanged", baseSha: sha, headSha: sha });
});
describe("durable validation evidence", () => {
  it("executes the plan saved for this run and exact checkpoint", async () => {
    const plan = {
      version: 1,
      commands: [{ key: "unit", command: "pnpm test", timeoutSeconds: 300, reports: [] }],
    };
    mocks.pinPlan.mockResolvedValue({ plan });
    const admin = adminMock();
    await validateCheckpoint({
      admin: admin as never,
      workspaceId: "ws",
      pipelineId: "pipeline",
      runId: "run",
      sandbox: {} as never,
      checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
      secrets: [],
    });
    expect(mocks.pinPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run", commitSha: sha }),
    );
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ plan, commitSha: sha }));
  });
  it.each([
    { approvedToolIds: undefined, reason: "runtime_unavailable" },
    { approvedToolIds: ["an-ordinary-tool-revision/read"], reason: "runtime_unavailable" },
    { approvedToolIds: [], reason: "tool_not_approved" },
  ])(
    "records $reason on the frozen identity while executing commands",
    async ({ approvedToolIds, reason }) => {
      const plan = {
        version: 2,
        commands: [{ key: "unit", command: "pnpm test", timeoutSeconds: 30, reports: [] }],
        browser: [
          {
            key: "inbox",
            path: "/inbox",
            timeoutSeconds: 10,
            interactions: [],
            regionTestId: "inbox-preview",
            excludedTestIds: [],
            evidence: [{ kind: "screenshot", required: true }],
          },
        ],
      };
      const runId = "11111111-1111-4111-8111-111111111111";
      mocks.pinPlan.mockResolvedValue({
        plan,
        browserIdentity: { runId, attemptCount: 3, commitSha: sha, treeSha: tree },
      });
      const admin = adminMock();
      admin.rpc.mockImplementation(async (name: string) => {
        if (name === "record_session_browser_verification") {
          throw new Error("browser receipt transport closed");
        }
        return { data: {}, error: null };
      });
      await validateCheckpoint({
        admin: admin as never,
        workspaceId: "ws",
        pipelineId: "pipeline",
        approvedToolIds,
        runId,
        sandbox: {} as never,
        checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
        secrets: [],
      });
      expect(admin.rpc).toHaveBeenCalledWith("record_session_browser_verification", {
        p_run_id: runId,
        p_attempt_count: 3,
        p_commit_sha: sha,
        p_validation_tree_sha: tree,
        p_records: [
          {
            key: "inbox",
            kind: "screenshot",
            path: "/inbox",
            policy: "isolated-fixture-v1",
            status: "unavailable",
            reason,
          },
        ],
      });
      expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ plan, commitSha: sha }));
      expect(admin.rpc).toHaveBeenCalledWith(
        "record_session_validation_evidence",
        expect.objectContaining({ p_run_id: runId }),
      );
    },
  );

  it("checks final checkout identity after text evidence before allowing browser capture", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const approvedToolScope = "11111111-1111-4111-8111-222222222222/capture";
    const captureScreenshot = vi.fn();
    mocks.pinPlan.mockResolvedValue({
      plan: {
        version: 2,
        commands: [],
        browser: [
          {
            key: "ready",
            path: "/fixture",
            timeoutSeconds: 10,
            interactions: [],
            regionTestId: "public",
            excludedTestIds: [],
            evidence: [{ kind: "screenshot", required: true }],
          },
        ],
      },
      browserIdentity: { runId, attemptCount: 1, commitSha: sha, treeSha: tree },
    });
    mocks.readIdentity.mockResolvedValue({ clean: true, commitSha: sha, treeSha: "c".repeat(40) });
    const admin = adminMock();
    await validateCheckpoint({
      admin: admin as never,
      workspaceId: "ws",
      pipelineId: "pipeline",
      approvedToolIds: [approvedToolScope],
      browserRuntime: { approvalScopeId: approvedToolScope, captureScreenshot },
      runId,
      sandbox: {} as never,
      checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
      secrets: [],
    });
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(admin.rpc.mock.calls.map(([name]) => name)).toEqual([
      "record_session_validation_evidence",
      "record_session_browser_verification",
    ]);
    expect(admin.rpc).toHaveBeenLastCalledWith(
      "record_session_browser_verification",
      expect.objectContaining({
        p_records: [expect.objectContaining({ status: "failed", reason: "source_changed" })],
      }),
    );
  });

  it("preserves source without running commands if the plan cannot be frozen", async () => {
    mocks.pinPlan.mockRejectedValue(new Error("plan conflict"));
    const admin = adminMock();
    const checkpoint = { kind: "unchanged" as const, baseSha: sha, headSha: sha };
    expect(
      await validateCheckpoint({
        admin: admin as never,
        workspaceId: "ws",
        pipelineId: "pipeline",
        runId: "run",
        sandbox: {} as never,
        checkpoint,
        secrets: [],
      }),
    ).toEqual(checkpoint);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("uploads redacted bytes with immutable workspace identity and hashes the persisted bytes", async () => {
    const admin = adminMock();
    await persistValidationEvidence({
      admin: admin as never,
      workspaceId: "ws",
      runId: "run",
      evidence: evidence(),
    });
    expect(mocks.upload).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        bucket: "session-validation-evidence",
        path: "ws/run/33333333-3333-4333-8333-333333333333",
        bytes: Buffer.from("[redacted] test passed"),
      }),
    );
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_session_validation_evidence",
      expect.objectContaining({
        p_commit_sha: sha,
        p_validation_tree_sha: tree,
        p_assets: [
          expect.objectContaining({
            key: "unit/report",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            sizeBytes: 22,
          }),
        ],
      }),
    );
  });
  it("does not mark a command passed when a required upload is inaccessible", async () => {
    mocks.upload.mockRejectedValue(new Error("provider secret detail"));
    const admin = adminMock();
    await persistValidationEvidence({
      admin: admin as never,
      workspaceId: "ws",
      runId: "run",
      evidence: evidence(),
    });
    expect(admin.rpc.mock.calls[0][1]).toMatchObject({
      p_assets: [],
      p_records: [
        expect.objectContaining({ status: "failed", missingRequiredReports: ["unit/report"] }),
      ],
    });
  });
  it("keeps optional asset failure distinct from a required report", async () => {
    mocks.upload.mockResolvedValue({ error: new Error("unavailable") });
    const admin = adminMock();
    const capture = evidence();
    capture.assets[0].required = false;
    await persistValidationEvidence({
      admin: admin as never,
      workspaceId: "ws",
      runId: "run",
      evidence: capture,
    });
    expect(admin.rpc.mock.calls[0][1]).toMatchObject({
      p_assets: [],
      p_records: [expect.objectContaining({ status: "passed", missingRequiredReports: [] })],
    });
  });
  it("uses static diagnostics on a failed record write", async () => {
    const admin = adminMock();
    admin.rpc.mockReturnValue(Promise.resolve({ data: null, error: new Error("secret") }));
    await expect(
      persistValidationEvidence({
        admin: admin as never,
        workspaceId: "ws",
        runId: "run",
        evidence: evidence(),
      }),
    ).rejects.toThrow(/^Validation evidence could not be recorded\.$/);
  });
  it("never executes validation for an analysis-only policy", async () => {
    const admin = adminMock();
    admin.query.maybeSingle.mockResolvedValue({
      data: { current_revision_id: "revision" },
      error: null,
    } as never);
    admin.query.single.mockResolvedValue({
      data: {
        requirements: {
          version: 1,
          deliveryMode: "analysis",
          requiredChecks: [],
          requiredEvidence: [],
          minimumApprovals: 0,
          requireCodeOwnerReview: false,
          requireResolvedThreads: false,
          freshnessSeconds: 60,
          requireArtifactApprovalForDelivery: false,
        },
      },
      error: null,
    });
    const checkpoint = { kind: "unchanged" as const, baseSha: sha, headSha: sha };
    expect(
      await validateCheckpoint({
        admin: admin as never,
        workspaceId: "ws",
        pipelineId: "pipeline",
        runId: "run",
        sandbox: {} as never,
        checkpoint,
        secrets: [],
      }),
    ).toBe(checkpoint);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("does not invent execution if the policy cannot be loaded", async () => {
    const admin = adminMock();
    admin.query.maybeSingle.mockResolvedValue({ data: null, error: new Error("detail") });
    await expect(shouldCaptureValidationEvidence(admin as never, "ws", "pipeline")).rejects.toThrow(
      "Validation policy is unavailable.",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("does not read the live delivery policy for a pinned revision or explicit absence", async () => {
    const admin = adminMock();
    admin.query.single.mockResolvedValue({
      data: {
        requirements: {
          version: 1,
          deliveryMode: "analysis",
          requiredChecks: [],
          requiredEvidence: [],
          minimumApprovals: 0,
          requireCodeOwnerReview: false,
          requireResolvedThreads: false,
          freshnessSeconds: 60,
          requireArtifactApprovalForDelivery: false,
        },
      },
      error: null,
    });
    expect(await shouldCaptureValidationEvidence(admin as never, "ws", "pipeline", null)).toBe(
      true,
    );
    expect(await shouldCaptureValidationEvidence(admin as never, "ws", "pipeline", "pinned")).toBe(
      false,
    );
    expect(admin.from).toHaveBeenCalledExactlyOnceWith("delivery_policy_revisions");
    expect(admin.query.eq).toHaveBeenCalledWith("id", "pinned");
  });
  it("preserves source even if evidence persistence fails", async () => {
    const admin = adminMock();
    admin.rpc.mockReturnValue(Promise.resolve({ error: new Error("unavailable") }));
    const input = {
      admin: admin as never,
      workspaceId: "ws",
      pipelineId: "pipeline",
      runId: "run",
      sandbox: {} as never,
      checkpoint: { kind: "unchanged" as const, baseSha: sha, headSha: sha },
      secrets: [],
    };
    expect(await validateCheckpoint(input)).toEqual(input.checkpoint);
    expect(mocks.checkpoint).toHaveBeenCalled();
  });
  it("retains a later edit and marks all prior passed receipts stale", async () => {
    const admin = adminMock();
    const finalSha = "c".repeat(40);
    mocks.checkpoint.mockResolvedValue({ kind: "unchanged", baseSha: sha, headSha: finalSha });
    const sandbox = {
      exec: vi.fn().mockResolvedValue({
        output: async () => ({ stdout: "d".repeat(40), stderr: "" }),
        exitCode: Promise.resolve(0),
      }),
    };
    await validateCheckpoint({
      admin: admin as never,
      workspaceId: "ws",
      pipelineId: "pipeline",
      runId: "run",
      sandbox: sandbox as never,
      checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
      secrets: [],
    });
    expect(admin.rpc.mock.calls[0][1]).toMatchObject({
      p_commit_sha: finalSha,
      p_records: [expect.objectContaining({ commitSha: sha, status: "stale" })],
    });
  });
  it.each(["exec", "output"])(
    "preserves captured source when the optional tree probe fails at %s",
    async (failure) => {
      const admin = adminMock();
      const finalCheckpoint = { kind: "unchanged" as const, baseSha: sha, headSha: "c".repeat(40) };
      mocks.checkpoint.mockResolvedValue(finalCheckpoint);
      const exec = vi.fn().mockImplementation(async () => {
        if (failure === "exec") throw new Error("private transport detail");
        return {
          output: async () => {
            throw new Error("private output detail");
          },
          exitCode: Promise.resolve(0),
        };
      });
      expect(
        await validateCheckpoint({
          admin: admin as never,
          workspaceId: "ws",
          pipelineId: "pipeline",
          runId: "run",
          sandbox: { exec } as never,
          checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
          secrets: [],
        }),
      ).toBe(finalCheckpoint);
      expect(admin.rpc).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
    },
  );

  it("propagates cancellation during the optional tree probe", async () => {
    const admin = adminMock();
    const controller = new AbortController();
    mocks.checkpoint.mockResolvedValue({
      kind: "unchanged",
      baseSha: sha,
      headSha: "c".repeat(40),
    });
    const exec = vi.fn(async () => {
      controller.abort();
      throw new Error("transport failed after abort");
    });
    await expect(
      validateCheckpoint({
        admin: admin as never,
        workspaceId: "ws",
        pipelineId: "pipeline",
        runId: "run",
        sandbox: { exec } as never,
        checkpoint: { kind: "unchanged", baseSha: sha, headSha: sha },
        secrets: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
