import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), capture: vi.fn(), checkpoint: vi.fn() }));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: mocks.upload }));
vi.mock("./capture", () => ({ captureValidationEvidence: mocks.capture }));
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
  mocks.checkpoint.mockResolvedValue({ kind: "unchanged", baseSha: sha, headSha: sha });
});
describe("durable validation evidence", () => {
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
});
