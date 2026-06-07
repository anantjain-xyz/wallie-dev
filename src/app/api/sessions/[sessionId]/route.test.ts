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

function makeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/sessions/${SESSION_ID}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

function routeContext(sessionId = SESSION_ID) {
  return { params: Promise.resolve({ sessionId }) };
}

function buildSupabaseMock(
  opts: {
    sessionError?: { message: string } | null;
    sessionRow?: { id: string; workspace_id: string } | null;
  } = {},
) {
  const sessionFilters: Array<[string, unknown]> = [];

  return {
    from(table: string) {
      if (table !== "sessions") {
        throw new Error(`unexpected supabase table ${table}`);
      }

      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            sessionFilters.push([column, value]);
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
    sessionFilters,
  };
}

function buildAdminMock(
  opts: {
    updateError?: { message: string } | null;
  } = {},
) {
  const updateCalls: Array<{
    filters: Array<[string, unknown]>;
    row: Record<string, unknown>;
  }> = [];

  return {
    admin: {
      from(table: string) {
        if (table !== "sessions") {
          throw new Error(`unexpected admin table ${table}`);
        }

        return {
          update: (row: Record<string, unknown>) => {
            const call = { filters: [] as Array<[string, unknown]>, row };
            updateCalls.push(call);

            const builder = {
              eq: (column: string, value: unknown) => {
                call.filters.push([column, value]);
                return builder;
              },
              select: () => ({
                single: async () => ({
                  data: opts.updateError
                    ? null
                    : {
                        id: SESSION_ID,
                        title: row.title,
                        updated_at: UPDATED_AT,
                      },
                  error: opts.updateError ?? null,
                }),
              }),
            };

            return builder;
          },
        };
      },
    },
    updateCalls,
  };
}

function setupAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "member" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });
}

describe("PATCH /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAdminMock = buildAdminMock();
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    setupAccess();
  });

  it("updates the trimmed title through a workspace-scoped admin write", async () => {
    const response = await PATCH(makeRequest({ title: "  Better title  " }), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: SESSION_ID,
      title: "Better title",
      updatedAt: UPDATED_AT,
    });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(currentAdminMock.updateCalls).toEqual([
      {
        filters: [
          ["id", SESSION_ID],
          ["workspace_id", WORKSPACE_ID],
        ],
        row: { title: "Better title" },
      },
    ]);
  });

  it("rejects empty titles before loading auth or session state", async () => {
    const response = await PATCH(makeRequest({ title: "   " }), routeContext());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Title is required." });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects invalid session ids before updating", async () => {
    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext("not-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Session id is invalid." });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated updates", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns not found for unknown or non-member-visible sessions", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock({ sessionRow: null }));

    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Session not found" });
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("requires active human workspace access before the admin update", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Only human workspace members can use this route.",
      ok: false,
      status: 403,
    });

    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Only human workspace members can use this route.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
