import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getObject } from "./[exportId]/objects/[kind]/[key]/route";
import { GET as getManifest } from "./[exportId]/route";
import { GET as listExports, POST as requestExport } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const exportId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";
const sessionId = "00000000-0000-4000-8000-000000000006";
const assetId = "00000000-0000-4000-8000-000000000005";
const date = "2026-11-15T00:00:00+00:00";
const sha256 = "a".repeat(64);

const job = {
  id: exportId,
  workspace_id: workspaceId,
  requested_by: userId,
  requested_at: date,
  snapshot_at: date,
  completed_at: date,
  expires_at: "2026-11-22T00:00:00+00:00",
  status: "completed",
  item_count: 2,
  next_ordinal: 3,
};

const mocks = vi.hoisted(() => ({
  requireWorkspaceAccessById: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  readObject: vi.fn(),
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocks.requireWorkspaceAccessById,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/lib/run-exports/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/run-exports/storage")>()),
  readRunExportObject: mocks.readObject,
}));

function context<T>(params: T) {
  return { params: Promise.resolve(params) };
}

function request(body: unknown = undefined) {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/run-exports`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function dbResult(data: unknown) {
  return { data, error: null };
}

function accessResult(data: unknown) {
  return { abortSignal: vi.fn().mockReturnValue({ maybeSingle: async () => dbResult(data) }) };
}

function pageQuery() {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    abortSignal: vi.fn(),
  };
  mocks.from.mockReturnValue(query);
  return query;
}

describe("workspace run export routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkspaceAccessById.mockImplementation(
      async (_id: string, options?: { includeSessionId?: boolean }) => ({
        ok: true,
        context: {
          user: options?.includeSessionId ? { id: userId, sessionId } : { id: userId },
          workspace: { id: workspaceId },
        },
      }),
    );
    mocks.rpc.mockImplementation(() => accessResult(job));
  });

  it("rejects cross-tenant access before touching export data or storage", async () => {
    mocks.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      error: "Workspace not found.",
      status: 404,
    });
    const response = await getObject(
      request(),
      context({ workspaceId, exportId, kind: "asset", key: assetId }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires a verified Supabase session id before authorizing a download", async () => {
    mocks.requireWorkspaceAccessById.mockResolvedValue({
      ok: true,
      context: { user: { id: userId }, workspace: { id: workspaceId } },
    });
    const response = await getManifest(request(), context({ workspaceId, exportId }));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never serializes internal access, request, or lease identifiers", async () => {
    mocks.rpc.mockResolvedValue(dbResult([{ ...job, request_id: requestId, lease_id: userId }]));
    const response = await listExports(request(), context({ workspaceId }));
    const body = await response.text();
    expect(mocks.rpc).toHaveBeenCalledWith("list_run_exports", {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_limit: 10,
    });
    expect(body).toContain(exportId);
    expect(body).not.toContain(userId);
    expect(body).not.toContain(requestId);
    expect(body).not.toContain("lease");
  });

  it("queues an idempotent request bound to the live workspace and manager", async () => {
    mocks.rpc.mockResolvedValue(
      dbResult({ ...job, status: "queued", item_count: 0, next_ordinal: 1 }),
    );
    const response = await requestExport(request({ requestId }), context({ workspaceId }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      export: { id: exportId, status: "queued", processedCount: 0 },
    });
    expect(mocks.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
      requireManager: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("request_run_export", {
      p_workspace_id: workspaceId,
      p_requested_by: userId,
      p_request_id: requestId,
    });
  });

  it("downloads every page descriptor and scopes each keyset read to the same export", async () => {
    const query = pageQuery();
    query.abortSignal
      .mockResolvedValueOnce(
        dbResult([{ first_ordinal: 1, last_ordinal: 1, sha256, size_bytes: 123 }]),
      )
      .mockResolvedValueOnce(
        dbResult([{ first_ordinal: 2, last_ordinal: 2, sha256, size_bytes: 124 }]),
      );
    const response = await getManifest(request(), context({ workspaceId, exportId }));
    expect(mocks.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
      includeSessionId: true,
      requireManager: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_run_export_access", {
      p_workspace_id: workspaceId,
      p_export_id: exportId,
      p_user_id: userId,
      p_session_id: sessionId,
    });
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(await response.json()).toMatchObject({
      exportId,
      itemCount: 2,
      pages: [
        {
          firstOrdinal: 1,
          lastOrdinal: 1,
          sha256,
          sizeBytes: 123,
          url: expect.stringMatching(/objects\/page\/1$/),
        },
        {
          firstOrdinal: 2,
          lastOrdinal: 2,
          sha256,
          sizeBytes: 124,
          url: expect.stringMatching(/objects\/page\/2$/),
        },
      ],
    });
    expect(query.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(query.eq).toHaveBeenCalledWith("export_id", exportId);
    expect(query.gte.mock.calls).toEqual([
      ["first_ordinal", 1],
      ["first_ordinal", 2],
    ]);
  });

  it("fails the manifest stream instead of returning valid JSON with a missing page", async () => {
    const query = pageQuery();
    query.abortSignal.mockResolvedValue(
      dbResult([{ first_ordinal: 2, last_ordinal: 2, sha256, size_bytes: 124 }]),
    );
    const response = await getManifest(request(), context({ workspaceId, exportId }));
    await expect(response.json()).rejects.toThrow("manifest index is incomplete");
  });

  it("never serves expired jobs or a download revoked while fetching private bytes", async () => {
    mocks.rpc.mockReturnValueOnce(accessResult({ ...job, status: "expired" }));
    const expired = await getManifest(request(), context({ workspaceId, exportId }));
    expect(expired.status).toBe(410);
    expect(mocks.from).not.toHaveBeenCalled();

    const query = pageQuery();
    query.abortSignal.mockReturnValue({
      maybeSingle: async () =>
        dbResult({ asset_id: assetId, sha256, size_bytes: 2, content_type: "text/plain" }),
    });
    mocks.rpc.mockReturnValueOnce(accessResult(job)).mockReturnValueOnce(accessResult(null));
    mocks.readObject.mockResolvedValue({
      status: "available",
      bytes: new TextEncoder().encode("OK"),
    });
    const response = await getObject(
      request(),
      context({ workspaceId, exportId, kind: "asset", key: assetId }),
    );
    expect(mocks.readObject).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        exportId,
        object: { kind: "asset", assetId, sha256, sizeBytes: 2, contentType: "text/plain" },
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("OK");
  });
});
