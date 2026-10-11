import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decodePipelineDashboardCursor: vi.fn(),
  loadPipelineDashboardLanePage: vi.fn(),
  loadPipelineDashboardSnapshot: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/features/pipeline/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/pipeline/data")>()),
  decodePipelineDashboardCursor: mocked.decodePipelineDashboardCursor,
  loadPipelineDashboardLanePage: mocked.loadPipelineDashboardLanePage,
  loadPipelineDashboardSnapshot: mocked.loadPipelineDashboardSnapshot,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PipelineWorkspaceUnavailableError } from "@/features/pipeline/data";

import { GET, POST } from "./route";

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
    await expect(response.json()).resolves.toEqual({
      code: "workspace_unavailable",
      error: "Workspace not found.",
    });
    expect(mocked.decodePipelineDashboardCursor).not.toHaveBeenCalled();
  });
  it("keeps a missing lane distinct from unavailable workspace access", async () => {
    grantAccess();
    mocked.decodePipelineDashboardCursor.mockReturnValue({
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
    });
    mocked.loadPipelineDashboardLanePage.mockResolvedValue(null);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Pipeline lane not found." });
  });
});

describe("GET /api/workspaces/[workspaceId]/pipeline-dashboard", () => {
  afterEach(() => vi.clearAllMocks());

  it("loads an uncached snapshot through the authorized RLS client", async () => {
    grantAccess();
    mocked.loadPipelineDashboardSnapshot.mockResolvedValue({ lanes: [], hasAnySession: true });
    const response = await GET(new Request("http://localhost/pipeline-dashboard"), routeContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ lanes: [], hasAnySession: true });
    expect(mocked.loadPipelineDashboardSnapshot).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      workspaceId: WORKSPACE_ID,
    });
  });

  it("does not read a board without workspace access", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
    const response = await GET(new Request("http://localhost/pipeline-dashboard"), routeContext());
    expect(response.status).toBe(403);
    expect(mocked.loadPipelineDashboardSnapshot).not.toHaveBeenCalled();
  });

  it("returns a failed recovery response when the snapshot query fails", async () => {
    grantAccess();
    mocked.loadPipelineDashboardSnapshot.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(new Request("http://localhost/pipeline-dashboard"), routeContext());
    expect(response.status).toBe(500);
  });
});

it.each(["GET", "POST"])(
  "returns workspace_unavailable when %s RPC loses membership after authorization",
  async (method) => {
    grantAccess();
    mocked.decodePipelineDashboardCursor.mockReturnValue({
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
    });
    mocked.loadPipelineDashboardSnapshot.mockRejectedValue(new PipelineWorkspaceUnavailableError());
    mocked.loadPipelineDashboardLanePage.mockRejectedValue(new PipelineWorkspaceUnavailableError());
    const response = await (method === "GET"
      ? GET(request(), routeContext())
      : POST(request(), routeContext()));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_unavailable" });
  },
);
