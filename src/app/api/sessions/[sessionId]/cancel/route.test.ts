import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cancelSessionWork: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadPinnedFactoryExecution: vi.fn(),
}));

vi.mock("@/lib/factory-definitions/runtime-definition", () => ({
  loadPinnedFactoryExecution: mocked.loadPinnedFactoryExecution,
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
  phase_status: "in_progress",
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
          maybeSingle: async () => ({
            data: {
              archived_at: null,
              current_artifact_id: "artifact-current",
              current_artifact_version: 2,
              currentStage: {
                description: "Build work",
                id: "stage-build",
                name: "Build",
                position: 1,
                slug: "build",
              },
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
    mocked.loadPinnedFactoryExecution.mockResolvedValue(null);
  });

  it("preserves the compiled stage label after stopping a pinned session", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminClient("rejected"));
    mocked.loadPinnedFactoryExecution.mockResolvedValue({
      stages: [
        { id: "stage-plan" },
        {
          id: "stage-build",
          name: "Frozen Build",
          slug: "frozen-build",
          description: "Immutable build step",
        },
      ],
    });
    const response = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ sessionId: session.id }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentStageId: "stage-build",
      currentStage: {
        id: "stage-build",
        name: "Frozen Build",
        slug: "frozen-build",
        description: "Immutable build step",
        position: 2,
      },
    });
  });

  it("returns the post-cancel row instead of a hardcoded rejected phase", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminClient("awaiting_review"));

    const response = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ sessionId: session.id }),
    });

    expect(response.status).toBe(200);
    expect(mocked.cancelSessionWork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: "Stage canceled by a workspace member.",
        sessionId: session.id,
        workspaceId: session.workspace_id,
      }),
    );
    await expect(response.json()).resolves.toEqual({
      archivedAt: null,
      currentArtifactId: "artifact-current",
      artifactVersion: 2,
      currentStage: {
        description: "Build work",
        id: "stage-build",
        name: "Build",
        position: 1,
        slug: "build",
      },
      currentStageId: "stage-build",
      id: session.id,
      phaseStatus: "awaiting_review",
      rejectionCount: 1,
      updatedAt: "2026-07-17T12:00:00.000Z",
    });
  });
});
