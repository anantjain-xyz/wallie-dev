import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PATCH } from "./route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-06-07T12:00:00.000Z";

let currentAdminMock: ReturnType<typeof buildAdminMock>;
let currentServerMock: ReturnType<typeof buildServerSupabaseMock>;

function request(body: unknown) {
  return new Request(`http://localhost/api/sessions/${SESSION_ID}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

function routeContext(sessionId = SESSION_ID) {
  return {
    params: Promise.resolve({ sessionId }),
  };
}

function buildServerSupabaseMock(
  opts: {
    sessionError?: { message: string } | null;
    sessionRow?: { id: string; workspace_id: string } | null;
  } = {},
) {
  const filters: Array<{ column: string; value: unknown }> = [];

  return {
    filters,
    supabase: {
      from(table: string) {
        if (table !== "sessions") {
          throw new Error(`unexpected server table ${table}`);
        }

        return {
          select: () => ({
            eq: (column: string, value: unknown) => {
              filters.push({ column, value });
              return {
                maybeSingle: async () => ({
                  data:
                    opts.sessionRow === undefined
                      ? { id: SESSION_ID, workspace_id: WORKSPACE_ID }
                      : opts.sessionRow,
                  error: opts.sessionError ?? null,
                }),
              };
            },
          }),
        };
      },
    },
  };
}

function buildAdminMock(
  opts: {
    updateError?: { message: string } | null;
    updatedRow?: { id: string; title: string; updated_at: string } | null;
  } = {},
) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];

  return {
    admin: {
      from(table: string) {
        if (table !== "sessions") {
          throw new Error(`unexpected admin table ${table}`);
        }

        return {
          update: (row: Record<string, unknown>) => {
            updates.push(row);
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              select: () => ({
                maybeSingle: async () => ({
                  data:
                    opts.updatedRow === undefined
                      ? {
                          id: SESSION_ID,
                          title: row.title as string,
                          updated_at: UPDATED_AT,
                        }
                      : opts.updatedRow,
                  error: opts.updateError ?? null,
                }),
              }),
            };
            return builder;
          },
        };
      },
    },
    filters,
    updates,
  };
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

describe("PATCH /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentServerMock = buildServerSupabaseMock();
    currentAdminMock = buildAdminMock();
    mocked.createSupabaseServerClient.mockResolvedValue(currentServerMock.supabase);
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    grantAccess();
  });

  it("trims and updates a session title through a workspace-scoped admin write", async () => {
    const response = await PATCH(request({ title: "  Updated session title  " }), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: SESSION_ID,
      title: "Updated session title",
      updatedAt: UPDATED_AT,
    });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(currentAdminMock.updates).toEqual([{ title: "Updated session title" }]);
    expect(currentAdminMock.filters).toEqual([
      { column: "id", value: SESSION_ID },
      { column: "workspace_id", value: WORKSPACE_ID },
    ]);
  });

  it("rejects whitespace-only titles before loading auth state", async () => {
    const response = await PATCH(request({ title: "   " }), routeContext());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Title is required." });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects invalid session ids", async () => {
    const response = await PATCH(request({ title: "Updated" }), routeContext("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Session id is invalid." });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("requires an authenticated Supabase user", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValueOnce(null);

    const response = await PATCH(request({ title: "Updated" }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns not found when the server client cannot read the session", async () => {
    currentServerMock = buildServerSupabaseMock({ sessionRow: null });
    mocked.createSupabaseServerClient.mockResolvedValueOnce(currentServerMock.supabase);

    const response = await PATCH(request({ title: "Updated" }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found." });
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("does not update when workspace membership access fails", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await PATCH(request({ title: "Updated" }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found." });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns not found if the scoped admin update finds no matching session", async () => {
    currentAdminMock = buildAdminMock({ updatedRow: null });
    mocked.createSupabaseAdminClient.mockReturnValueOnce(currentAdminMock.admin);

    const response = await PATCH(request({ title: "Updated" }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found." });
    expect(currentAdminMock.filters).toEqual([
      { column: "id", value: SESSION_ID },
      { column: "workspace_id", value: WORKSPACE_ID },
    ]);
  });
});
