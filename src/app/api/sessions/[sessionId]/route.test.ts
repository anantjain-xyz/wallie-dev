import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { PATCH } from "./route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-06-07T12:00:00.000Z";

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
    updateError?: { message: string } | null;
  } = {},
) {
  const updateCalls: Array<{
    filters: Array<[string, unknown]>;
    row: Record<string, unknown>;
  }> = [];

  return {
    client: {
      from(table: string) {
        if (table !== "sessions") throw new Error(`unexpected supabase table ${table}`);

        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  opts.sessionRow === undefined
                    ? { id: SESSION_ID, workspace_id: WORKSPACE_ID }
                    : opts.sessionRow,
                error: opts.sessionError ?? null,
              }),
            }),
          }),
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
                    : { id: SESSION_ID, title: row.title, updated_at: UPDATED_AT },
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

describe("PATCH /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
  });

  it("updates through the same authenticated RLS client and returns the reconciliation row", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const response = await PATCH(makeRequest({ title: "  Better title  " }), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: SESSION_ID,
      title: "Better title",
      updatedAt: UPDATED_AT,
    });
    expect(mocked.createSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(mocked.getSupabaseUserOrNull).toHaveBeenCalledTimes(1);
    expect(supabase.updateCalls).toEqual([
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
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_input",
      error: "Title is required.",
    });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects invalid session ids before authenticating", async () => {
    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext("not-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_input" });
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("preserves unauthenticated semantics with a canonical code", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "unauthorized", error: "Unauthorized" });
  });

  it("returns 404 for a cross-workspace session hidden by RLS without attempting a write", async () => {
    const supabase = buildSupabaseMock({ sessionRow: null });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const response = await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "not_found",
      error: "Session not found",
    });
    expect(supabase.updateCalls).toHaveLength(0);
  });

  it("records auth, lookup, authorization, and mutation timing spans", async () => {
    vi.stubEnv("WALLIE_TIMING_LOGS", "1");
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await PATCH(makeRequest({ title: "Better title" }), routeContext());

    expect(timingLog).toHaveBeenCalledWith(
      "[server-timing]",
      expect.objectContaining({
        name: "session.update-title",
        segments: expect.arrayContaining([
          expect.objectContaining({ name: "auth" }),
          expect.objectContaining({ name: "lookup" }),
          expect.objectContaining({ name: "authorization" }),
          expect.objectContaining({ name: "mutation" }),
        ]),
      }),
    );
    vi.unstubAllEnvs();
  });
});
