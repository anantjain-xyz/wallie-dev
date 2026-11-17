import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createFactory: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  listFactoryScope: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/factories/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/factories/scope")>();
  return {
    ...actual,
    createFactory: mocked.createFactory,
    listFactoryScope: mocked.listFactoryScope,
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET, POST } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "00000000-0000-4000-8000-000000000002";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factories`;
const context = { params: Promise.resolve({ workspaceId }) };
const admin = { rpc: vi.fn() };

const factory = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "Payments",
  slug: "payments",
  is_default: false,
  status: "active",
  archived_at: null,
  archived_reason: null,
  created_at: "2026-11-16T00:00:00Z",
};
const scope = {
  factoryId: factory.id,
  name: factory.name,
  slug: factory.slug,
  isDefault: false,
  status: "active" as const,
  role: "manager" as const,
  sessionCount: 0,
  pipelineCount: 0,
  repositoryCount: 0,
  memberCount: 1,
};

function authorized() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      currentMember: { id: "member-id", role: "owner" },
      supabase: { from: vi.fn() },
      user: { id: actorUserId },
      workspace: { id: workspaceId },
    },
  });
}

function post(body: unknown) {
  return POST(
    new Request(routeUrl, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    context,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
});

describe("factory scope route", () => {
  it("returns the caller-scoped factory list", async () => {
    authorized();
    mocked.listFactoryScope.mockResolvedValue([scope]);

    const response = await GET(new Request(routeUrl), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ factories: [scope] });
    expect(mocked.listFactoryScope).toHaveBeenCalledWith(admin, workspaceId, actorUserId);
  });

  it("rejects an invalid workspace id before touching data", async () => {
    const response = await GET(new Request("http://localhost/api/workspaces/nope/factories"), {
      params: Promise.resolve({ workspaceId: "nope" }),
    });
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("forwards a workspace access failure", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });
    const response = await GET(new Request(routeUrl), context);
    expect(response.status).toBe(404);
  });

  it("creates a factory for a workspace manager", async () => {
    authorized();
    mocked.createFactory.mockResolvedValue(factory);

    const response = await post({ name: "Payments", slug: "payments" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ factory });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
      requireManager: true,
    });
    expect(mocked.createFactory).toHaveBeenCalledWith(admin, {
      actorUserId,
      name: "Payments",
      slug: "payments",
      workspaceId,
    });
  });

  it("rejects malformed factory input", async () => {
    authorized();
    const response = await post({ name: "", slug: "Not A Slug" });
    expect(response.status).toBe(400);
    expect(mocked.createFactory).not.toHaveBeenCalled();
  });

  it("maps a duplicate slug to a conflict", async () => {
    authorized();
    mocked.createFactory.mockRejectedValue({ code: "23505" });

    const response = await post({ name: "Payments", slug: "payments" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That factory slug is already used in this workspace.",
    });
  });
});
