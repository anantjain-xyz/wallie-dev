import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decodePipelineDashboardCursor: vi.fn(),
  loadPipelineDashboardLanePage: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/features/pipeline/data", () => ({
  decodePipelineDashboardCursor: mocked.decodePipelineDashboardCursor,
  loadPipelineDashboardLanePage: mocked.loadPipelineDashboardLanePage,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PIPELINE_ID = "10000000-0000-4000-8000-000000000001";
const STAGE_ID = "20000000-0000-4000-8000-000000000001";

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function request(
  body: unknown = {
    cursor: "opaque",
    pipelineId: PIPELINE_ID,
    seenIds: ["30000000-0000-4000-8000-000000000001"],
    stageId: STAGE_ID,
  },
) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/pipeline-dashboard`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      supabase: { rpc: vi.fn() },
      workspace: { id: WORKSPACE_ID },
    },
    ok: true,
  });
}

describe("POST /api/workspaces/[workspaceId]/pipeline-dashboard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads only the requested pinned-pipeline lane", async () => {
    grantAccess();
    const cursor = {
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
    };
    mocked.decodePipelineDashboardCursor.mockReturnValue(cursor);
    mocked.loadPipelineDashboardLanePage.mockResolvedValue({
      cards: [],
      cursor: null,
      id: STAGE_ID,
      pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
      totalCount: 25,
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.loadPipelineDashboardLanePage).toHaveBeenCalledTimes(1);
    expect(mocked.loadPipelineDashboardLanePage).toHaveBeenCalledWith({
      pipelineId: PIPELINE_ID,
      seenIds: ["30000000-0000-4000-8000-000000000001"],
      stageId: STAGE_ID,
      supabase: expect.any(Object),
      workspaceId: WORKSPACE_ID,
    });
  });

  it("rejects a cursor from another lane", async () => {
    grantAccess();
    mocked.decodePipelineDashboardCursor.mockReturnValue({
      pipelineId: PIPELINE_ID,
      stageId: "90000000-0000-4000-8000-000000000001",
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(400);
    expect(mocked.loadPipelineDashboardLanePage).not.toHaveBeenCalled();
  });

  it("does not query a lane when workspace access is denied", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(404);
    expect(mocked.decodePipelineDashboardCursor).not.toHaveBeenCalled();
  });
});
