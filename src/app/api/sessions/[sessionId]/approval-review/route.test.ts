import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  evaluateSessionPrReadiness: vi.fn(),
}));
vi.mock("@/features/sessions/review/http", async () => ({
  ...(await vi.importActual("@/features/sessions/review/http")),
  loadReviewContext: mocks.loadReviewContext,
}));
vi.mock("@/lib/pipeline/pr-readiness", () => ({
  evaluateSessionPrReadiness: mocks.evaluateSessionPrReadiness,
}));
import { GET } from "./route";
const sessionId = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ sessionId }) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluateSessionPrReadiness.mockResolvedValue(null);
});
it("counts every open blocker in the authenticated session, including earlier artifacts and stages", async () => {
  const eq = vi.fn().mockReturnThis();
  const query = {
    eq,
    select: vi.fn().mockReturnThis(),
    then: (callback: (value: unknown) => unknown) =>
      Promise.resolve({ count: 3, error: null }).then(callback),
  };
  const from = vi.fn(() => query);
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 9 },
    supabase: { from },
  });
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({ reviewRevision: 9, blockingCount: 3 });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(from).toHaveBeenCalledWith("artifact_review_threads");
  expect(eq.mock.calls).toEqual([
    ["workspace_id", "workspace"],
    ["session_id", sessionId],
    ["kind", "blocking"],
    ["status", "open"],
  ]);
});
it("exposes the server-owned delivery readiness for the final approval gate", async () => {
  const eq = vi.fn().mockReturnThis();
  const query = {
    eq,
    select: vi.fn().mockReturnThis(),
    then: (callback: (value: unknown) => unknown) =>
      Promise.resolve({ count: 0, error: null }).then(callback),
  };
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 4 },
    supabase: { from: vi.fn(() => query) },
  });
  mocks.evaluateSessionPrReadiness.mockResolvedValue({
    policy: {
      requirements: {
        deliveryMode: "code",
        requireArtifactApprovalForDelivery: true,
      },
    },
    finalStage: true,
    recorded: false,
    evaluation: {
      state: "blocked",
      blockers: [{ code: "github_required_check_failed", requirement: "CI" }],
    },
  });
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({
    reviewRevision: 4,
    blockingCount: 0,
    delivery: {
      required: true,
      state: "blocked",
      blockers: [{ code: "github_required_check_failed", requirement: "CI" }],
    },
  });
  expect(mocks.evaluateSessionPrReadiness).toHaveBeenCalledWith(
    { from: expect.any(Function) },
    sessionId,
    { record: false },
  );
});
it("omits delivery readiness when the evaluator cannot resolve the policy", async () => {
  const eq = vi.fn().mockReturnThis();
  const query = {
    eq,
    select: vi.fn().mockReturnThis(),
    then: (callback: (value: unknown) => unknown) =>
      Promise.resolve({ count: 1, error: null }).then(callback),
  };
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 2 },
    supabase: { from: vi.fn(() => query) },
  });
  mocks.evaluateSessionPrReadiness.mockRejectedValue(new Error("policy unavailable"));
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({ reviewRevision: 2, blockingCount: 1 });
});
it("does not turn a missing count into permission to approve", async () => {
  const query = {
    select: () => query,
    eq: () => query,
    then: (callback: (value: unknown) => unknown) =>
      Promise.resolve({ count: null, error: null }).then(callback),
  };
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 9 },
    supabase: { from: () => query },
  });
  expect((await GET(new Request("http://localhost"), params)).status).toBe(500);
});
it("does not load review details when active membership is unavailable", async () => {
  mocks.loadReviewContext.mockRejectedValue({ code: "42501" });
  expect((await GET(new Request("http://localhost"), params)).status).toBe(403);
});
