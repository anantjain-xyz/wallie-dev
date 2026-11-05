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

const ARTIFACT_ID = "a1b2c3d4-0001-4000-8000-000000000001";
const STAGE_ID = "d1b2c3d4-0001-4000-8000-000000000001";
const UPDATED_AT = "2026-07-17T12:00:00.000Z";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/sessions/sess-1/phase-action", {
    body: JSON.stringify({
      artifactId: ARTIFACT_ID,
      stageId: STAGE_ID,
      expectedReviewRevision: 7,
      ...body,
    }),
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
    memberRow?: { id: string; role: string; kind?: string; is_active?: boolean } | null;
    sessionRow?: Record<string, unknown> | null;
    resultError?: { message: string };
  } = {},
) {
  const memberFilters: Array<[string, unknown]> = [];
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
                  data:
                    !opts.resultError && columns.includes("current_artifact_version")
                      ? {
                          archived_at: null,
                          current_artifact_id: "artifact-current",
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
                  error: opts.resultError ?? null,
                }),
              }),
            }),
          };
        }
        if (table === "workspace_members") {
          const builder = {
            eq(column: string, value: unknown) {
              memberFilters.push([column, value]);
              return builder;
            },
            maybeSingle: async () => {
              const result = await memberLookup();
              const kind = opts.memberRow?.kind ?? "human";
              const active = opts.memberRow?.is_active ?? true;
              if (
                memberFilters.some(
                  ([column, value]) =>
                    (column === "kind" && kind !== value) ||
                    (column === "is_active" && active !== value),
                )
              )
                return { data: null, error: null };
              return result;
            },
          };
          return { select: () => builder };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
    memberLookup,
    memberFilters,
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

  it.each(["approve", "reject"])(
    "requires the immutable review snapshot for %s",
    async (action) => {
      for (const missing of ["artifactId", "stageId"]) {
        const response = await POST(
          makeRequest({ action, version: 1, feedback: "revise", [missing]: undefined }),
          routeContext(),
        );
        expect(response.status).toBe(400);
      }
      expect(mocked.handleApproval).not.toHaveBeenCalled();
      expect(mocked.handleRejection).not.toHaveBeenCalled();
    },
  );

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
      currentArtifactId: "artifact-current",
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
      expectedArtifactId: ARTIFACT_ID,
      expectedStageId: STAGE_ID,
      expectedWorkspaceId: "ws-1",
      feedbackText: "Needs sharper scope.",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
  });

  it("rejects unparseable bodies with the invalid_input envelope", async () => {
    const missingVersion = await POST(makeRequest({ action: "approve" }), routeContext());
    expect(missingVersion.status).toBe(400);
    await expect(missingVersion.json()).resolves.toMatchObject({ code: "invalid_input" });

    const stringVersion = await POST(
      makeRequest({ action: "approve", version: "1" }),
      routeContext(),
    );
    expect(stringVersion.status).toBe(400);
    await expect(stringVersion.json()).resolves.toMatchObject({ code: "invalid_input" });

    const unknownAction = await POST(makeRequest({ action: "noop", version: 1 }), routeContext());
    expect(unknownAction.status).toBe(400);
    await expect(unknownAction.json()).resolves.toMatchObject({ code: "invalid_input" });

    expect(mocked.handleApproval).not.toHaveBeenCalled();
    expect(mocked.handleRejection).not.toHaveBeenCalled();
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
  const submission = {
    requestId: "e1b2c3d4-0001-4000-8000-000000000001",
    expectedReviewRevision: 4,
    selectedThreadIds: ["f1b2c3d4-0001-4000-8000-000000000001"],
  };

  it("accepts selected comments without a whole-stage note and returns stable generation IDs", async () => {
    mocked.handleRejection.mockResolvedValue({
      feedbackBatchId: "batch-1",
      jobId: "job-1",
      revisionRunId: "run-1",
      success: true,
    });
    const response = await POST(
      makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      feedbackBatchId: "batch-1",
      revisionJobId: "job-1",
      revisionRunId: "run-1",
      revisionGeneration: "job-1",
    });
    expect(mocked.handleRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackText: "",
        feedbackSubmission: submission,
        requestedByMemberId: "mem-reviewer",
      }),
    );
  });

  it.each(["rejected", "completed"])(
    "allows idempotent receipt replay after the session becomes %s",
    async (phase) => {
      mocked.createSupabaseServerClient.mockResolvedValue(
        buildSupabase({
          sessionRow: {
            id: "sess-1",
            workspace_id: "ws-1",
            current_stage_id: "stage-later",
            phase_status: phase,
            archived_at: UPDATED_AT,
          },
        }).client,
      );
      mocked.handleRejection.mockResolvedValue({
        feedbackBatchId: "original-batch",
        jobId: "original-job",
        revisionRunId: "original-run",
        success: true,
      });
      const response = await POST(
        makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
        routeContext(),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        feedbackBatchId: "original-batch",
        revisionGeneration: "original-job",
      });
      expect(mocked.handleRejection).toHaveBeenCalledOnce();
    },
  );

  it("still authenticates membership before an archived receipt replay", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(
      buildSupabase({
        memberRow: null,
        sessionRow: {
          id: "sess-1",
          workspace_id: "ws-1",
          phase_status: "rejected",
          archived_at: UPDATED_AT,
        },
      }).client,
    );
    const response = await POST(
      makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
      routeContext(),
    );
    expect(response.status).toBe(403);
    expect(mocked.handleRejection).not.toHaveBeenCalled();
  });

  it.each([{ kind: "agent" }, { is_active: false }])(
    "requires an active human actor for a submitted batch %j",
    async (invalidActor) => {
      const { client, memberFilters } = buildSupabase({
        memberRow: { id: "mem-bot", role: "owner", ...invalidActor },
      });
      mocked.createSupabaseServerClient.mockResolvedValue(client);
      const response = await POST(
        makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
        routeContext(),
      );
      expect(response.status).toBe(403);
      expect(memberFilters).toContainEqual(["kind", "human"]);
      expect(memberFilters).toContainEqual(["is_active", true]);
      expect(mocked.handleRejection).not.toHaveBeenCalled();
    },
  );

  it("returns an accepted receipt if the committed generation's reconciliation read is unavailable", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(
      buildSupabase({ resultError: { message: "Private DB detail" } }).client,
    );
    mocked.handleRejection.mockResolvedValue({
      feedbackBatchId: "batch-1",
      jobId: "job-1",
      revisionRunId: "run-1",
      success: true,
    });
    const response = await POST(
      makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
      routeContext(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      feedbackBatchId: "batch-1",
      revisionJobId: "job-1",
      revisionRunId: "run-1",
      revisionGeneration: "job-1",
      reconciliationRequired: true,
    });
  });

  it.each([
    {
      ...submission,
      selectedThreadIds: [submission.selectedThreadIds[0], submission.selectedThreadIds[0]],
    },
    { ...submission, selectedThreadIds: ["foreign-malformed"] },
    {
      ...submission,
      selectedThreadIds: Array.from(
        { length: 21 },
        (_, i) => `f1b2c3d4-0001-4000-8000-${String(i).padStart(12, "0")}`,
      ),
    },
    { ...submission, expectedReviewRevision: -1 },
    { ...submission, expectedReviewRevision: 1.5 },
    { ...submission, actorMemberId: "spoofed" },
  ])("rejects malformed feedback intent without mutating %j", async (feedbackSubmission) => {
    const response = await POST(
      makeRequest({ action: "reject", version: 1, feedbackSubmission }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(mocked.handleRejection).not.toHaveBeenCalled();
  });

  it("requires a note or selected threads and rejects an oversized note without truncation", async () => {
    for (const feedbackText of ["", "a".repeat(4001)]) {
      const response = await POST(
        makeRequest({
          action: "reject",
          version: 1,
          feedbackText,
          feedbackSubmission: { ...submission, selectedThreadIds: [] },
        }),
        routeContext(),
      );
      expect(response.status).toBe(400);
    }
    expect(mocked.handleRejection).not.toHaveBeenCalled();
  });

  it.each([
    ["40001", 409, "stale_version"],
    ["23505", 409, "mutation_conflict"],
    ["22023", 400, "invalid_input"],
    ["22001", 400, "invalid_input"],
    ["42501", 403, "forbidden"],
  ])("maps batch error %s to actionable status", async (errorCode, status, code) => {
    mocked.handleRejection.mockResolvedValue({
      errorCode,
      error: "Select at most 100 comments in one feedback batch.",
      success: false,
    });
    const response = await POST(
      makeRequest({ action: "reject", version: 1, feedbackSubmission: submission }),
      routeContext(),
    );
    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload.code).toBe(code);
    if (errorCode === "22001") expect(payload.error).toContain("100 comments");
  });
  it("rejects approval without an inspected review token", async () => {
    const response = await POST(
      makeRequest({ action: "approve", version: 1, expectedReviewRevision: undefined }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(mocked.handleApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["PT409", "blocking_review", "Resolve or supersede"],
    ["PT412", "stale_version", "This review changed"],
  ])("returns a deterministic approval conflict for %s", async (errorCode, code, message) => {
    mocked.handleApproval.mockResolvedValue({
      success: false,
      errorCode,
      error: "Database conflict",
    });
    const response = await POST(makeRequest({ action: "approve", version: 1 }), routeContext());
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe(code);
    expect(payload.error).toContain(message);
    expect(mocked.handleApproval).toHaveBeenCalledWith(
      expect.objectContaining({ expectedReviewRevision: 7 }),
    );
  });
});
