import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executionPolicyResponseSchema,
  executionPolicyUpdateSchema,
  executionRequirementsSchema,
  type ExecutionRequirements,
} from "@/lib/execution-policy/contracts";

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
const userId = "00000000-0000-4000-8000-000000000003";
const revisionId = "00000000-0000-4000-8000-000000000004";
const requirements: ExecutionRequirements = {
  version: 1,
  maxRepairAttempts: 3,
  maxExecutionMs: 3_600_000,
  maxTotalTokens: 100_000,
  maxCostUsd: 12.5,
};
const policyRow = {
  id: revisionId,
  workspace_id: workspaceId,
  revision: 2,
  requirements,
  created_at: "2026-11-06T00:00:00Z",
  created_by: userId,
};
const mappedPolicy = {
  id: revisionId,
  workspaceId,
  revision: 2,
  requirements,
  createdAt: "2026-11-06T00:00:00Z",
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function getRequest() {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/execution-policy`);
}

function putRequest(body: unknown = { expectedRevision: 1, requirements }) {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/execution-policy`, {
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

describe("explicit versioned execution requirements", () => {
  it("requires every field, including explicitly nullable telemetry limits", () => {
    const unlimited = { ...requirements, maxTotalTokens: null, maxCostUsd: null };
    expect(executionRequirementsSchema.parse(unlimited)).toEqual(unlimited);
    for (const field of Object.keys(requirements)) {
      const incomplete: Record<string, unknown> = { ...requirements };
      delete incomplete[field];
      expect(executionRequirementsSchema.safeParse(incomplete).success, field).toBe(false);
    }
  });

  it("accepts the inclusive limits and a no-repair policy", () => {
    expect(
      executionRequirementsSchema.parse({
        version: 1,
        maxRepairAttempts: 0,
        maxExecutionMs: 1_000,
        maxTotalTokens: 1,
        maxCostUsd: 0.000001,
      }),
    ).toEqual({
      version: 1,
      maxRepairAttempts: 0,
      maxExecutionMs: 1_000,
      maxTotalTokens: 1,
      maxCostUsd: 0.000001,
    });
    expect(
      executionRequirementsSchema.safeParse({
        ...requirements,
        maxRepairAttempts: 100,
        maxExecutionMs: 86_400_000,
        maxTotalTokens: 1_000_000_000_000,
        maxCostUsd: 1_000_000,
      }).success,
    ).toBe(true);
  });

  it.each([
    { version: 2 },
    { maxRepairAttempts: -1 },
    { maxRepairAttempts: 101 },
    { maxRepairAttempts: 1.5 },
    { maxExecutionMs: 999 },
    { maxExecutionMs: 86_400_001 },
    { maxExecutionMs: 1000.5 },
    { maxTotalTokens: 0 },
    { maxTotalTokens: 1_000_000_000_001 },
    { maxTotalTokens: 1.5 },
    { maxCostUsd: 0 },
    { maxCostUsd: 0.0000009 },
    { maxCostUsd: 1_000_001 },
    { maxDurationMs: 3_600_000 },
  ])("rejects unsupported or ambiguous configuration: %j", (override) => {
    expect(executionRequirementsSchema.safeParse({ ...requirements, ...override }).success).toBe(
      false,
    );
  });

  it("requires an optimistic revision and rejects caller-supplied authority", () => {
    const update = { expectedRevision: 0, requirements };
    expect(executionPolicyUpdateSchema.parse(update)).toEqual(update);
    expect(executionPolicyUpdateSchema.safeParse({ ...update, expectedRevision: -1 }).success).toBe(
      false,
    );
    expect(executionPolicyUpdateSchema.safeParse({ ...update, actorUserId: userId }).success).toBe(
      false,
    );
    expect(executionPolicyResponseSchema.parse({ policy: null })).toEqual({ policy: null });
  });
});

describe("GET execution policy", () => {
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

  it("returns no invented policy for an unconfigured workspace", async () => {
    const current = queryResult(null);
    const from = grantAccess(vi.fn().mockReturnValue(current));
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ policy: null });
    expect(from).toHaveBeenCalledWith("execution_policies");
    expect(current.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("reads the current immutable revision through the scoped RLS client", async () => {
    const current = queryResult({ current_revision_id: revisionId });
    const revision = queryResult(policyRow);
    grantAccess(vi.fn().mockReturnValueOnce(current).mockReturnValueOnce(revision));
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ policy: mappedPolicy });
    expect(revision.eq).toHaveBeenCalledWith("id", revisionId);
    expect(revision.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
  });

  it("fails closed when a current revision cannot be read", async () => {
    grantAccess(
      vi
        .fn()
        .mockReturnValueOnce(queryResult({ current_revision_id: revisionId }))
        .mockReturnValueOnce(queryResult(null, { message: "private database detail" })),
    );
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not load the execution policy.",
    });
  });
});

describe("PUT execution policy", () => {
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

  it("rejects incomplete requirements instead of defaulting missing limits", async () => {
    grantAccess();
    const incomplete = { ...requirements, maxTotalTokens: undefined };
    const response = await PUT(
      putRequest({ expectedRevision: 1, requirements: incomplete }),
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
    expect(rpc).toHaveBeenCalledWith("save_execution_policy", {
      p_workspace_id: workspaceId,
      p_actor_user_id: userId,
      p_expected_revision: 1,
      p_requirements: requirements,
    });
    await expect(response.json()).resolves.toEqual({ policy: mappedPolicy });
  });

  it.each([
    ["PT409", 409],
    ["42501", 403],
    ["22023", 400],
    ["23503", 400],
    ["23514", 400],
    ["P0002", 400],
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
