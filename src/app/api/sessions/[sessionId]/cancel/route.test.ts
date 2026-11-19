import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cancelOnce: vi.fn(),
  cleanupSessionWorkReceipt: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadPinnedFactoryExecution: vi.fn(),
}));

vi.mock("@/lib/factory-definitions/runtime-definition", () => ({
  loadPinnedFactoryExecution: mocked.loadPinnedFactoryExecution,
}));
vi.mock("@/lib/pipeline/cancel", () => ({
  cleanupSessionWorkReceipt: mocked.cleanupSessionWorkReceipt,
}));
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
  factory_id: "factory-1",
  workspace_id: "workspace-1",
};
const memberId = "member-1";
const intent = {
  requestId: "57100000-0000-4000-8000-000000000001",
  expectedRunId: "57100000-0000-4000-8000-000000000002",
};
const receipt = { job_ids: ["job-1"], run_ids: [intent.expectedRunId], replayed: false };
const context = { params: Promise.resolve({ sessionId: session.id }) };

function request(body: unknown = intent) {
  return new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function buildServerClient() {
  return {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === "sessions" ? session : { id: memberId },
          error: null,
        }),
      };
      return query;
    },
  };
}

function buildAdminClient(resultPhaseStatus: string) {
  return {
    rpc: mocked.cancelOnce,
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
    mocked.cancelOnce.mockReturnValue({ single: async () => ({ data: receipt, error: null }) });
    mocked.cleanupSessionWorkReceipt.mockResolvedValue(undefined);
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
    const response = await POST(request(), context);
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

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(mocked.cancelOnce).toHaveBeenCalledWith("cancel_session_command_once", {
      actor_member_id: memberId,
      expected_run_id: intent.expectedRunId,
      target_factory_id: session.factory_id,
      target_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      target_request_id: intent.requestId,
      target_session_id: session.id,
      target_workspace_id: session.workspace_id,
    });
    expect(mocked.cleanupSessionWorkReceipt).toHaveBeenCalledWith(expect.anything(), {
      receipt,
      workspaceId: session.workspace_id,
    });
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

  it("replays the exact cancellation even after the session has advanced", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminClient("awaiting_review"));
    const replay = { ...receipt, replayed: true };
    mocked.cancelOnce.mockReturnValue({ single: async () => ({ data: replay, error: null }) });

    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocked.cleanupSessionWorkReceipt).toHaveBeenCalledWith(expect.anything(), {
      receipt: replay,
      workspaceId: session.workspace_id,
    });
  });

  it("rejects stale generations and stops before provider cleanup", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminClient("in_progress"));
    mocked.cancelOnce.mockReturnValue({
      single: async () => ({ data: null, error: { code: "P0003", message: "Private detail" } }),
    });

    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(mocked.cleanupSessionWorkReceipt).not.toHaveBeenCalled();
    await expect(response.text()).resolves.not.toContain("Private detail");
  });

  it("requires a displayed generation and retained request ID", async () => {
    const response = await POST(request({ expectedRunId: intent.expectedRunId }), context);
    expect(response.status).toBe(400);
    expect(mocked.cancelOnce).not.toHaveBeenCalled();
  });
});
