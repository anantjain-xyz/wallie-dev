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
const earlierThread = {
  id: "44444444-4444-4444-8444-444444444444",
  artifact_id: "55555555-5555-4555-8555-555555555555",
  artifact_version: 1,
  stage_slug: "plan",
};
function reviewQuery(count: number | null, data: (typeof earlierThread)[] = []) {
  return {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (callback: (value: unknown) => unknown) =>
      Promise.resolve({ count, data, error: null }).then(callback),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluateSessionPrReadiness.mockResolvedValue(null);
});
it("counts every open blocker in the authenticated session, including earlier artifacts and stages", async () => {
  const query = reviewQuery(3, [earlierThread]);
  const from = vi.fn(() => query);
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 9 },
    supabase: { from },
  });
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({
    reviewRevision: 9,
    blockingCount: 3,
    blockingTarget: {
      artifactId: earlierThread.artifact_id,
      artifactVersion: 1,
      stageSlug: "plan",
      threadId: earlierThread.id,
    },
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(from).toHaveBeenCalledWith("artifact_review_threads");
  expect(query.eq.mock.calls).toEqual([
    ["workspace_id", "workspace"],
    ["session_id", sessionId],
    ["kind", "blocking"],
    ["status", "open"],
  ]);
  expect(query.order.mock.calls).toEqual([
    ["created_at", { ascending: true }],
    ["id", { ascending: true }],
  ]);
  expect(query.limit).toHaveBeenCalledWith(1);
});
it("exposes the server-owned delivery readiness for the final approval gate", async () => {
  const query = reviewQuery(0);
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
    blockingTarget: null,
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
  const query = reviewQuery(0);
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: "workspace", artifact_review_revision: 2 },
    supabase: { from: vi.fn(() => query) },
  });
  mocks.evaluateSessionPrReadiness.mockRejectedValue(new Error("policy unavailable"));
  const response = await GET(new Request("http://localhost"), params);
  expect(await response.json()).toEqual({
    reviewRevision: 2,
    blockingCount: 0,
    blockingTarget: null,
  });
});
it("does not turn a missing count into permission to approve", async () => {
  const query = reviewQuery(null);
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
