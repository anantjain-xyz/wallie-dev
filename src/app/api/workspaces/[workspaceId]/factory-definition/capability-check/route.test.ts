import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  after: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  readFactoryDefinitionCapabilityCheck: vi.fn(),
  startFactoryDefinitionCapabilityCheck: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocked.after,
}));
vi.mock("@/lib/factory-definitions/capability-checks", () => ({
  readFactoryDefinitionCapabilityCheck: mocked.readFactoryDefinitionCapabilityCheck,
  startFactoryDefinitionCapabilityCheck: mocked.startFactoryDefinitionCapabilityCheck,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET, POST } from "./route";

const workspaceId = "a0000000-0000-4000-8000-000000000001";
const actorUserId = "a0000000-0000-4000-8000-000000000002";
const targetId = "a0000000-0000-4000-8000-000000000003";
const checkId = "a0000000-0000-4000-8000-000000000004";
const url = `http://localhost/api/workspaces/${workspaceId}/factory-definition/capability-check`;
const context = () => ({ params: Promise.resolve({ workspaceId }) });

const check = {
  agentModel: "gpt-5.6-sol",
  agentProvider: "codex",
  capabilities: {},
  checkedAt: "2026-11-15T00:00:00Z",
  errorText: null,
  githubRepositoryId: "a0000000-0000-4000-8000-000000000005",
  id: checkId,
  sandboxProvider: "daytona",
  sandboxVercelProjectId: null,
  sandboxVercelTeamId: null,
  status: "running",
};

function authorize() {
  const admin = { rpc: vi.fn() };
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { user: { id: actorUserId }, workspace: { id: workspaceId } },
  });
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  return admin;
}

function post(body: unknown) {
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, context());
}

beforeEach(() => vi.resetAllMocks());

describe("GET saved factory definition capability check", () => {
  it.each(["draft", "revision"] as const)(
    "reads from the workspace-scoped %s identity",
    async (kind) => {
      const admin = authorize();
      const latest = { ...check, status: "success" };
      mocked.readFactoryDefinitionCapabilityCheck.mockResolvedValue({ ok: true, check: latest });

      const response = await GET(new Request(`${url}?${kind}Id=${targetId}`), context());

      expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
        requireManager: true,
      });
      expect(mocked.readFactoryDefinitionCapabilityCheck).toHaveBeenCalledWith({
        admin,
        workspaceId,
        target: { kind, id: targetId },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ check: latest });
    },
  );

  it.each([
    "",
    "?draftId=invalid",
    `?draftId=${targetId}&revisionId=${targetId}`,
    `?revisionId=${targetId}&revisionId=${targetId}`,
    `?revisionId=${targetId}&sandboxProvider=vercel`,
    `?revisionId=${targetId}&repositoryId=${check.githubRepositoryId}&repositoryId=${check.githubRepositoryId}`,
  ])("accepts exactly one typed target (%s)", async (query) => {
    authorize();
    const response = await GET(new Request(`${url}${query}`), context());
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocked.readFactoryDefinitionCapabilityCheck).not.toHaveBeenCalled();
  });

  it("normalizes the requested repository for the capability check", async () => {
    const admin = authorize();
    mocked.readFactoryDefinitionCapabilityCheck.mockResolvedValue({ ok: true, check });
    mocked.startFactoryDefinitionCapabilityCheck.mockResolvedValue({
      ok: true,
      check,
      complete: vi.fn(),
    });
    const target = { kind: "revision", id: targetId };
    const repositoryId = check.githubRepositoryId;

    const response = await GET(
      new Request(`${url}?revisionId=${targetId}&repositoryId=${repositoryId.toUpperCase()}`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(mocked.readFactoryDefinitionCapabilityCheck).toHaveBeenCalledWith({
      admin,
      workspaceId,
      target,
      repositoryId,
    });
    expect((await post({ target, repositoryId: repositoryId.toUpperCase() })).status).toBe(202);
    expect(mocked.startFactoryDefinitionCapabilityCheck).toHaveBeenCalledWith({
      admin,
      workspaceId,
      actorUserId,
      target,
      repositoryId,
    });
  });

  it("requires manager access to read capability results", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Access denied.",
    });
    const response = await GET(new Request(`${url}?draftId=${targetId}`), context());
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});

describe("POST saved factory definition capability check", () => {
  it.each(["draft", "revision"] as const)(
    "reserves a check and completes the %s probe after the response",
    async (kind) => {
      const admin = authorize();
      const target = { kind, id: targetId };
      const complete = vi.fn().mockResolvedValue(undefined);
      mocked.startFactoryDefinitionCapabilityCheck.mockResolvedValue({ ok: true, check, complete });

      const response = await post({ target });

      expect(mocked.startFactoryDefinitionCapabilityCheck).toHaveBeenCalledWith({
        admin,
        workspaceId,
        actorUserId,
        target,
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ check });
      expect(complete).not.toHaveBeenCalled();
      expect(mocked.after).toHaveBeenCalledTimes(1);
      const runAfter = mocked.after.mock.calls[0]?.[0];
      if (typeof runAfter !== "function") throw new Error("Expected deferred completion.");
      await runAfter();
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it("leaves the request body unread when manager access fails", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Sign in.",
    });
    const request = new Request(url, { method: "POST", body: "not valid JSON" });
    const response = await POST(request, context());
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocked.after).not.toHaveBeenCalled();
  });

  it.each([
    { target: { kind: "draft", id: targetId, agentModel: "gpt-5.6-sol" } },
    { target: { kind: "revision", id: targetId }, actorUserId },
    { target: { kind: "revision", id: targetId }, sandboxProvider: "vercel" },
    { target: { kind: "draft", id: "invalid" } },
    { target: { kind: "repository", id: targetId } },
  ])("rejects extra caller authority or invalid targets (%j)", async (body) => {
    authorize();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocked.startFactoryDefinitionCapabilityCheck).not.toHaveBeenCalled();
    expect(mocked.after).not.toHaveBeenCalled();
  });

  it("returns failed reservations before scheduling a probe", async () => {
    authorize();
    const error = "Sandbox connection changed.";
    mocked.startFactoryDefinitionCapabilityCheck.mockResolvedValue({
      ok: false,
      status: 409,
      error,
    });
    const response = await post({ target: { kind: "draft", id: targetId } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(mocked.after).not.toHaveBeenCalled();
  });
});
