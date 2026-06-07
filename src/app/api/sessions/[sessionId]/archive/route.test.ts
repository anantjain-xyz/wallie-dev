import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("@/lib/pipeline/archive", () => ({
  archiveSession: mocked.archiveSession,
  unarchiveSession: mocked.unarchiveSession,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: mocked.enforceRateLimit,
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

import { DELETE, POST } from "./route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function routeContext(sessionId = SESSION_ID) {
  return { params: Promise.resolve({ sessionId }) };
}

function makeRequest(method: "DELETE" | "POST") {
  return new Request(`http://localhost/api/sessions/${SESSION_ID}/archive`, { method });
}

function buildSupabaseMock(
  opts: {
    sessionError?: { message: string } | null;
    sessionRow?: { id: string; workspace_id: string } | null;
  } = {},
) {
  return {
    from(table: string) {
      if (table !== "sessions") {
        throw new Error(`unexpected supabase table ${table}`);
      }
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
      };
    },
  };
}

describe("/api/sessions/[sessionId]/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.enforceRateLimit.mockResolvedValue({ response: null, result: {} });
    mocked.archiveSession.mockResolvedValue({
      archivedAt: "2026-06-07T12:00:00.000Z",
      id: SESSION_ID,
    });
    mocked.unarchiveSession.mockResolvedValue({ archivedAt: null, id: SESSION_ID });
  });

  it("archives the session and echoes its archived_at", async () => {
    const response = await POST(makeRequest("POST"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archivedAt: "2026-06-07T12:00:00.000Z",
      id: SESSION_ID,
    });
    expect(mocked.archiveSession).toHaveBeenCalledWith(
      {},
      { reason: "Session archived by a workspace member.", sessionId: SESSION_ID },
    );
    expect(mocked.enforceRateLimit).toHaveBeenCalledWith("phaseAction", `${WORKSPACE_ID}:user-1`);
  });

  it("unarchives the session", async () => {
    const response = await DELETE(makeRequest("DELETE"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ archivedAt: null, id: SESSION_ID });
    expect(mocked.unarchiveSession).toHaveBeenCalledWith({}, { sessionId: SESSION_ID });
  });

  it("rejects unauthenticated requests before mutating", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await POST(makeRequest("POST"), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
    expect(mocked.archiveSession).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns 404 for sessions the member cannot see", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock({ sessionRow: null }));

    const response = await POST(makeRequest("POST"), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Session not found" });
    expect(mocked.archiveSession).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("honors the rate limiter", async () => {
    mocked.enforceRateLimit.mockResolvedValue({
      response: NextResponse.json({ error: "Too many requests" }, { status: 429 }),
      result: {},
    });

    const response = await POST(makeRequest("POST"), routeContext());

    expect(response.status).toBe(429);
    expect(mocked.archiveSession).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
