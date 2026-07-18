import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { GET } from "./route";

const result = {
  archived_at: null,
  current_artifact_version: 0,
  currentStage: {
    description: "Newly inserted stage",
    id: "stage-new",
    name: "New stage",
    position: 1,
    slug: "new-stage",
  },
  current_stage_id: "stage-new",
  id: "session-1",
  phase_status: "agent_generating" as const,
  rejection_count: 0,
  updated_at: "2026-07-18T16:00:00.000Z",
};

function buildClient(data: typeof result | null = result) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
      }),
    }),
  };
}

describe("GET /api/sessions/[sessionId]/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseServerClient.mockResolvedValue(buildClient());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
  });

  it("returns the current stage snapshot for targeted realtime reconciliation", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ sessionId: result.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archivedAt: null,
      artifactVersion: 0,
      currentStage: result.currentStage,
      currentStageId: "stage-new",
      id: "session-1",
      phaseStatus: "agent_generating",
      rejectionCount: 0,
      updatedAt: "2026-07-18T16:00:00.000Z",
    });
  });

  it("keeps cross-workspace sessions hidden by RLS", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildClient(null));

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ sessionId: result.id }),
    });

    expect(response.status).toBe(404);
  });
});
