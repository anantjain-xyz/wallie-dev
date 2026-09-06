import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadSessionReviewCapabilities: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocked.getSupabaseUserOrNull }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));
vi.mock("@/features/sessions/detail/review-capabilities", () => ({
  loadSessionReviewCapabilities: mocked.loadSessionReviewCapabilities,
}));

import { GET } from "./route";

const session = { id: "session-1", current_stage_id: "stage-a", workspace_id: "workspace-1" };
const capabilities = { canApprove: true, failedStageSlug: null, hasFailedRun: false };
function client(data: typeof session | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data, error: null }),
        }),
      }),
    }),
  };
}
function get() {
  return GET(new Request("http://localhost"), {
    params: Promise.resolve({ sessionId: session.id }),
  });
}

describe("GET review capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseServerClient.mockResolvedValue(client(session));
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.loadSessionReviewCapabilities.mockResolvedValue(capabilities);
  });

  it("returns the stage identity used to evaluate approval permissions", async () => {
    const response = await get();
    await expect(response.json()).resolves.toEqual({ ...capabilities, stageId: "stage-a" });
    expect(mocked.loadSessionReviewCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: "stage-a",
        sessionId: session.id,
        memberUserId: "user-1",
        workspaceId: "workspace-1",
      }),
    );
  });

  it("keeps an RLS access miss distinguishable from transient errors", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(client(null));
    expect((await get()).status).toBe(404);
    expect(mocked.loadSessionReviewCapabilities).not.toHaveBeenCalled();
  });

  it("does not evaluate capabilities after the viewer signs out", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(mocked.loadSessionReviewCapabilities).not.toHaveBeenCalled();
  });
});
