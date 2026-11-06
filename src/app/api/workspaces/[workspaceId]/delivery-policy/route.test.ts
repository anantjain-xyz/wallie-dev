import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET, PUT } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const pipelineId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const revisionId = "00000000-0000-4000-8000-000000000004";
const requirements = {
  version: 1,
  deliveryMode: "code",
  requiredChecks: ["check"],
  minimumApprovals: 1,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: ["tests"],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: false,
};
const policyRow = {
  id: revisionId,
  workspace_id: workspaceId,
  pipeline_id: pipelineId,
  revision: 2,
  requirements,
  created_at: "2026-11-06T00:00:00Z",
  created_by: userId,
};
const mappedPolicy = {
  id: revisionId,
  workspaceId,
  pipelineId,
  revision: 2,
  requirements,
  createdAt: "2026-11-06T00:00:00Z",
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function getRequest(query = `pipelineId=${pipelineId}`) {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/delivery-policy?${query}`);
}

function putRequest(body: unknown = { pipelineId, expectedRevision: 1, requirements }) {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/delivery-policy`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function queryResult(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function grantAccess(from = vi.fn()) {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      workspace: { id: workspaceId },
      user: { id: userId },
      supabase: { from },
    },
  });
  return from;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET delivery policy", () => {
  it("requires active workspace access before querying policy records", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Sign in first.",
    });
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(401);
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("validates the pipeline query before reading data", async () => {
    const from = grantAccess();
    const response = await GET(getRequest("pipelineId=other"), context());
    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("does not reveal a pipeline outside the authorized workspace", async () => {
    const pipeline = queryResult(null);
    const from = grantAccess(vi.fn().mockReturnValue(pipeline));
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(404);
    expect(pipeline.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(pipeline.eq).toHaveBeenCalledWith("id", pipelineId);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("returns no invented policy for a legacy pipeline", async () => {
    const pipeline = queryResult({ id: pipelineId });
    const current = queryResult(null);
    const from = grantAccess(vi.fn().mockReturnValueOnce(pipeline).mockReturnValueOnce(current));
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ policy: null });
    expect(from).toHaveBeenCalledWith("delivery_policies");
    expect(current.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(current.eq).toHaveBeenCalledWith("pipeline_id", pipelineId);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("reads the current immutable revision through the scoped RLS client", async () => {
    const pipeline = queryResult({ id: pipelineId });
    const current = queryResult({ current_revision_id: revisionId });
    const revision = queryResult(policyRow);
    grantAccess(
      vi
        .fn()
        .mockReturnValueOnce(pipeline)
        .mockReturnValueOnce(current)
        .mockReturnValueOnce(revision),
    );
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ policy: mappedPolicy });
    expect(revision.eq).toHaveBeenCalledWith("id", revisionId);
    expect(revision.eq).toHaveBeenCalledWith("pipeline_id", pipelineId);
    expect(revision.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
  });

  it("fails closed when a current revision cannot be read", async () => {
    grantAccess(
      vi
        .fn()
        .mockReturnValueOnce(queryResult({ id: pipelineId }))
        .mockReturnValueOnce(queryResult({ current_revision_id: revisionId }))
        .mockReturnValueOnce(queryResult(null, { message: "private database detail" })),
    );
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not load the delivery policy.",
    });
  });
});

describe("PUT delivery policy", () => {
  it("requires a manager and does not initialize an admin client after denial", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Workspace admin access is required.",
    });
    const response = await PUT(putRequest(), context());
    expect(response.status).toBe(403);
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
      requireManager: true,
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before attempting a privileged write", async () => {
    grantAccess();
    const request = new Request(getRequest().url, { method: "PUT", body: "{" });
    const response = await PUT(request, context());
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects incomplete requirements instead of defaulting missing checks", async () => {
    grantAccess();
    const incomplete = { ...requirements, requiredChecks: undefined };
    const response = await PUT(
      putRequest({ pipelineId, expectedRevision: 1, requirements: incomplete }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("pins the authorized actor and expected revision in the privileged save", async () => {
    grantAccess();
    const rpc = vi.fn().mockResolvedValue({ data: policyRow, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({ rpc });
    const response = await PUT(putRequest(), context());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("save_delivery_policy", {
      p_workspace_id: workspaceId,
      p_pipeline_id: pipelineId,
      p_actor_user_id: userId,
      p_expected_revision: 1,
      p_requirements: requirements,
    });
    await expect(response.json()).resolves.toEqual({ policy: mappedPolicy });
  });

  it.each([
    ["PT409", 409],
    ["42501", 403],
    ["23514", 400],
    ["XX000", 500],
  ])("maps database error %s without leaking internal details", async (code, status) => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({
      rpc: vi
        .fn()
        .mockResolvedValue({ data: null, error: { code, message: "private database detail" } }),
    });
    const response = await PUT(putRequest(), context());
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("private database detail");
  });
});
