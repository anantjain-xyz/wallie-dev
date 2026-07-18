import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cancelSessionWork: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/pipeline/cancel", () => ({ cancelSessionWork: mocked.cancelSessionWork }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocked.enforceRateLimit }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { POST } from "./route";

const session = {
  id: "session-1",
  phase_status: "agent_generating",
  workspace_id: "workspace-1",
};

function buildServerClient() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: session, error: null }) }),
      }),
    }),
  };
}

function buildAdminClient(resultPhaseStatus: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              archived_at: null,
              current_artifact_version: 2,
              current_stage_id: "stage-build",
              id: session.id,
              phase_status: resultPhaseStatus,
              rejection_count: 1,
              updated_at: "2026-07-17T12:00:00.000Z",
            },
            error: null,
          }),
        }),
      }),
    }),
  };
}

describe("POST /api/sessions/[sessionId]/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseServerClient.mockResolvedValue(buildServerClient());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.enforceRateLimit.mockResolvedValue({ response: null, result: {} });
    mocked.cancelSessionWork.mockResolvedValue(undefined);
  });

  it("returns the post-cancel row instead of a hardcoded rejected phase", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminClient("awaiting_review"));

    const response = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ sessionId: session.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archivedAt: null,
      artifactVersion: 2,
      currentStageId: "stage-build",
      id: session.id,
      phaseStatus: "awaiting_review",
      rejectionCount: 1,
      updatedAt: "2026-07-17T12:00:00.000Z",
    });
  });
});
