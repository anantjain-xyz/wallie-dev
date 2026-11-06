import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  loadSessionPrReadinessDetails: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ admin: true })),
}));

vi.mock("@/features/sessions/review/http", async () => ({
  ...(await vi.importActual("@/features/sessions/review/http")),
  loadReviewContext: mocks.loadReviewContext,
}));
vi.mock("@/lib/pipeline/pr-readiness", () => ({
  loadSessionPrReadinessDetails: mocks.loadSessionPrReadinessDetails,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { GET } from "./route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const policyId = "33333333-3333-4333-8333-333333333333";
const observationId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const params = { params: Promise.resolve({ sessionId }) };
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);

const delivery = {
  requirements: {
    version: 1,
    deliveryMode: "code",
    requiredChecks: ["CI"],
    minimumApprovals: 1,
    requireCodeOwnerReview: false,
    requireResolvedThreads: true,
    requiredEvidence: ["tests"],
    freshnessSeconds: 3600,
    requireArtifactApprovalForDelivery: true,
  },
  policyRevisionId: policyId,
  finalStage: true,
  approvalGated: true,
  observationStale: false,
  evaluation: {
    state: "ready",
    blockers: [],
    dimensions: {
      githubAccess: "passed",
      identity: "passed",
      checks: "passed",
      reviews: "passed",
      threads: "passed",
      evidence: "passed",
      mergeability: "passed",
    },
    summary: {
      githubAccess: "available",
      checks: "passed",
      reviews: "passed",
      evidence: "passed",
      threads: "passed",
    },
  },
  pr: {
    repositoryFullName: "acme/app",
    repositoryUrl: "https://github.com/acme/app",
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    headSha: sha,
    baseSha,
    observedAt: "2026-11-06T00:00:00Z",
  },
  checks: [{ context: "CI", appId: null, sources: ["policy"], status: "passed" }],
  review: {
    decision: "APPROVED",
    currentHeadApprovals: 1,
    minimumApprovals: 1,
    codeOwnersRequired: false,
    requireResolvedThreads: true,
    unresolvedThreads: 0,
    mergeStateStatus: "CLEAN",
    protection: "verified",
  },
  evidence: {
    runId,
    commitSha: sha,
    validationTreeSha: baseSha,
    createdAt: "2026-11-06T00:00:00Z",
    required: [{ key: "tests", status: "passed" }],
    records: [
      {
        key: "tests",
        command: "pnpm test",
        provenance: "harness",
        status: "passed",
        exitCode: 0,
        startedAt: "2026-11-06T00:00:00Z",
        completedAt: "2026-11-06T00:01:00Z",
        commitSha: sha,
        treeSha: baseSha,
        finalCommitSha: sha,
        finalTreeSha: baseSha,
        reportKeys: ["tests/report"],
        missingRequiredReports: [],
      },
    ],
    assets: [
      {
        id: assetId,
        key: "tests/report",
        kind: "report",
        required: true,
        sizeBytes: 128,
        downloadUrl: `/api/sessions/${sessionId}/validation-evidence/assets/${assetId}`,
      },
    ],
  },
  artifactBlockingCount: 0,
  artifactBlockingTarget: null,
  refresh: {
    status: "current",
    lastErrorCode: null,
    updatedAt: "2026-11-06T00:01:00Z",
    canRefresh: true,
  },
  sourceObservationId: observationId,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: workspaceId },
    supabase: {},
  });
});

it("returns the live server-owned readiness detail for the authenticated session", async () => {
  mocks.loadSessionPrReadinessDetails.mockResolvedValue(delivery);
  const response = await GET(new Request("http://localhost"), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ delivery });
  expect(mocks.loadSessionPrReadinessDetails).toHaveBeenCalledWith({ admin: true }, sessionId);
});

it("omits delivery detail when the pipeline has no policy", async () => {
  mocks.loadSessionPrReadinessDetails.mockResolvedValue(null);
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({ delivery: null });
});

it("requires an authenticated workspace member before reading provider state", async () => {
  mocks.loadReviewContext.mockRejectedValue({ code: "42501" });
  const response = await GET(new Request("http://localhost"), params);
  expect(response.status).toBe(403);
  expect(mocks.loadSessionPrReadinessDetails).not.toHaveBeenCalled();
});
