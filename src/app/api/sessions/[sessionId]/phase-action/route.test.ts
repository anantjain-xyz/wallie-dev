import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  handleApproval: vi.fn(),
  handleRejection: vi.fn(),
}));

vi.mock("@/lib/pipeline/processor", () => ({
  handleApproval: mocked.handleApproval,
  handleRejection: mocked.handleRejection,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocked.enforceRateLimit }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { POST } from "./route";

const UPDATED_AT = "2026-07-17T12:00:00.000Z";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/sessions/sess-1/phase-action", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function routeContext() {
  return { params: Promise.resolve({ sessionId: "sess-1" }) };
}

function buildSupabase(
  opts: {
    memberPromise?: Promise<{ data: { id: string; role: string } | null; error: null }>;
    memberRow?: { id: string; role: string } | null;
    sessionRow?: Record<string, unknown> | null;
  } = {},
) {
  const memberLookup = vi.fn(async () =>
    opts.memberPromise
      ? opts.memberPromise
      : {
          data:
            opts.memberRow === undefined ? { id: "mem-reviewer", role: "owner" } : opts.memberRow,
          error: null,
        },
  );
  const initialSession =
    opts.sessionRow === undefined
      ? {
          archived_at: null,
          current_stage_id: "stage-product",
          id: "sess-1",
          phase_status: "awaiting_review",
          workspace_id: "ws-1",
        }
      : opts.sessionRow;

  return {
    client: {
      from(table: string) {
        if (table === "sessions") {
          return {
            select: (columns: string) => ({
              eq: () => ({
                maybeSingle: async () => ({ data: initialSession, error: null }),
                single: async () => ({
                  data: columns.includes("current_artifact_version")
                    ? {
                        archived_at: null,
                        current_artifact_version: 1,
                        currentStage: {
                          description: "Product work",
                          id: "stage-product",
                          name: "Product",
                          position: 0,
                          slug: "product",
                        },
                        current_stage_id: "stage-product",
                        id: "sess-1",
                        phase_status: "rejected",
                        rejection_count: 2,
                        updated_at: UPDATED_AT,
                      }
                    : null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "workspace_members") {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: memberLookup }) }) }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
    memberLookup,
  };
}

function buildAdmin() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { anyone_can_approve: false, approver_member_ids: [], name: "Product" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
}

describe("POST /api/sessions/[sessionId]/phase-action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabase().client);
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdmin());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.enforceRateLimit.mockResolvedValue({
      response: null,
      result: { retryAfterSeconds: 0 },
    });
    mocked.handleApproval.mockResolvedValue({ jobId: null, success: true });
    mocked.handleRejection.mockResolvedValue({ jobId: "job-1", success: true });
  });

  it("overlaps rate limiting and membership lookup after the session lookup", async () => {
    let resolveRateLimit!: (value: unknown) => void;
    let resolveMember!: (value: { data: { id: string; role: string }; error: null }) => void;
    const rateLimitPromise = new Promise((resolve) => {
      resolveRateLimit = resolve;
    });
    const memberPromise = new Promise<{ data: { id: string; role: string }; error: null }>(
      (resolve) => {
        resolveMember = resolve;
      },
    );
    mocked.enforceRateLimit.mockReturnValue(rateLimitPromise);
    const supabase = buildSupabase({ memberPromise });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const responsePromise = POST(
      makeRequest({ action: "reject", feedbackText: "Needs sharper scope.", version: 1 }),
      routeContext(),
    );

    await vi.waitFor(() => {
      expect(mocked.enforceRateLimit).toHaveBeenCalledTimes(1);
      expect(supabase.memberLookup).toHaveBeenCalledTimes(1);
    });
    resolveRateLimit({ response: null, result: { retryAfterSeconds: 0 } });
    resolveMember({ data: { id: "mem-reviewer", role: "owner" }, error: null });
    expect((await responsePromise).status).toBe(200);
  });

  it("returns the minimal reconciliation contract after a valid rejection", async () => {
    const response = await POST(
      makeRequest({ action: "reject", feedbackText: "Needs sharper scope.", version: 1 }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archivedAt: null,
      artifactVersion: 1,
      currentStage: {
        description: "Product work",
        id: "stage-product",
        name: "Product",
        position: 0,
        slug: "product",
      },
      currentStageId: "stage-product",
      id: "sess-1",
      phaseStatus: "rejected",
      rejectionCount: 2,
      updatedAt: UPDATED_AT,
    });
    expect(mocked.handleRejection).toHaveBeenCalledWith({
      expectedWorkspaceId: "ws-1",
      feedbackText: "Needs sharper scope.",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
  });

  it("returns 404 for a cross-workspace session hidden by RLS", async () => {
    const supabase = buildSupabase({ sessionRow: null });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const response = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "not_found",
      error: "Session not found",
    });
    expect(mocked.enforceRateLimit).not.toHaveBeenCalled();
    expect(supabase.memberLookup).not.toHaveBeenCalled();
    expect(mocked.handleApproval).not.toHaveBeenCalled();
  });

  it("preserves CAS conflict semantics with a canonical stale-version code", async () => {
    mocked.handleRejection.mockResolvedValue({
      error: "Version mismatch: a newer version exists.",
      success: false,
    });

    const response = await POST(
      makeRequest({ action: "reject", feedbackText: "Needs work.", version: 1 }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "stale_version",
      error: "Version mismatch: a newer version exists.",
    });
  });

  it("preserves rate-limit status, headers, and retry metadata", async () => {
    const rateLimited = NextResponse.json(
      { error: "Rate limit exceeded. Please retry later.", retryAfterSeconds: 12 },
      { headers: { "Retry-After": "12", "X-RateLimit-Remaining": "0" }, status: 429 },
    );
    mocked.enforceRateLimit.mockResolvedValue({
      response: rateLimited,
      result: { retryAfterSeconds: 12 },
    });

    const response = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(response.json()).resolves.toEqual({
      code: "rate_limited",
      error: "Rate limit exceeded. Please retry later.",
      retryAfterSeconds: 12,
    });
    expect(mocked.handleApproval).not.toHaveBeenCalled();
  });

  it("preserves unauthorized, archived, and approver-forbidden HTTP semantics", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValueOnce(null);
    const unauthorized = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ code: "unauthorized" });

    mocked.createSupabaseServerClient.mockResolvedValueOnce(
      buildSupabase({
        sessionRow: {
          archived_at: UPDATED_AT,
          current_stage_id: "stage-product",
          id: "sess-1",
          phase_status: "awaiting_review",
          workspace_id: "ws-1",
        },
      }).client,
    );
    const archived = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());
    expect(archived.status).toBe(409);
    await expect(archived.json()).resolves.toMatchObject({ code: "archived" });

    mocked.createSupabaseAdminClient.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  anyone_can_approve: false,
                  approver_member_ids: ["someone-else"],
                  name: "Product",
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });
    const forbidden = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "forbidden" });
  });

  it("allows a regular workspace member when anyone can approve", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(
      buildSupabase({ memberRow: { id: "mem-reviewer", role: "member" } }).client,
    );
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { anyone_can_approve: true, approver_member_ids: [], name: "Product" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const response = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());

    expect(response.status).toBe(200);
    expect(mocked.handleApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approverMemberId: "mem-reviewer" }),
    );
  });

  it("records auth, lookup, authorization, rate-limit, and mutation timing spans", async () => {
    vi.stubEnv("WALLIE_TIMING_LOGS", "1");
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await POST(
      makeRequest({ action: "reject", feedbackText: "Needs sharper scope.", version: 1 }),
      routeContext(),
    );

    expect(timingLog).toHaveBeenCalledWith(
      "[server-timing]",
      expect.objectContaining({
        name: "session.phase-action",
        segments: expect.arrayContaining([
          expect.objectContaining({ name: "auth" }),
          expect.objectContaining({ name: "lookup" }),
          expect.objectContaining({ name: "authorization" }),
          expect.objectContaining({ name: "rate-limit" }),
          expect.objectContaining({ name: "mutation" }),
          expect.objectContaining({ name: "mutation.result" }),
        ]),
      }),
    );
    vi.unstubAllEnvs();
  });
});
