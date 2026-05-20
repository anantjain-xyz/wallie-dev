import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  after: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  enqueueWallieRun: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: mocked.after,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/wallie/service", () => ({
  enqueueWallieRun: mocked.enqueueWallieRun,
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { POST } from "./route";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
let currentAdminMock: ReturnType<typeof buildAdminMock>;

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/sessions", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function buildSupabaseMock(
  opts: {
    firstStageRow?: { id: string } | null;
    nextNumber?: number;
    onboardingRow?: { status: string } | null;
    pipelineRow?: { id: string } | null;
  } = {},
) {
  return {
    from(table: string) {
      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  opts.onboardingRow === undefined ? { status: "completed" } : opts.onboardingRow,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "pipelines") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.pipelineRow === undefined ? { id: "pipe-1" } : opts.pipelineRow,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "pipeline_stages") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: opts.firstStageRow === undefined ? { id: "stage-1" } : opts.firstStageRow,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected supabase table ${table}`);
    },
    rpc: vi.fn(async () => ({ data: opts.nextNumber ?? 7, error: null })),
  };
}

function buildAdminMock(opts: { sessionInsertError?: { message: string } | null } = {}) {
  const insertedSessions: Array<Record<string, unknown>> = [];
  const deletedSessionIds: string[] = [];

  const admin = {
    from(table: string) {
      if (table !== "sessions") {
        throw new Error(`unexpected admin table ${table}`);
      }
      return {
        delete: () => ({
          eq: async (_column: string, value: string) => {
            deletedSessionIds.push(value);
            return { error: null };
          },
        }),
        insert: (row: Record<string, unknown>) => {
          insertedSessions.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: opts.sessionInsertError
                  ? null
                  : {
                      id: "11111111-1111-4111-8111-111111111111",
                      number: row.number,
                    },
                error: opts.sessionInsertError ?? null,
              }),
            }),
          };
        },
      };
    },
  };

  return { admin, deletedSessionIds, insertedSessions };
}

function setupAccess(opts: Parameters<typeof buildSupabaseMock>[0] = {}) {
  const supabase = buildSupabaseMock(opts);

  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role: "owner" },
      supabase,
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });

  return supabase;
}

describe("POST /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAccess();
    currentAdminMock = buildAdminMock();
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);
    mocked.enqueueWallieRun.mockResolvedValue({
      created: true,
      jobId: "job-1",
      run: { id: "run-1" },
    });
    mocked.processQueuedAgentJobs.mockResolvedValue({ processed: true });
  });

  it("creates a session, queues the first Wallie run, and schedules processing", async () => {
    const response = await POST(
      makeRequest({
        linearIssueUrl: "https://linear.app/team/issue/TEAM-42/some-slug",
        promptMd: "Add SSO",
        title: "SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ number: 7, processScheduled: true });
    expect(currentAdminMock.insertedSessions[0]).toMatchObject({
      creator_member_id: MEMBER_ID,
      current_stage_id: "stage-1",
      linear_issue_id: "TEAM-42",
      phase_status: "agent_generating",
      pipeline_id: "pipe-1",
      prompt_md: "Add SSO",
      title: "SSO",
      workspace_id: WORKSPACE_ID,
    });
    expect(mocked.enqueueWallieRun).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByMemberId: MEMBER_ID,
        sessionId: "11111111-1111-4111-8111-111111111111",
        triggerType: "assignment",
      }),
    );
    expect(mocked.after).toHaveBeenCalledTimes(1);
    const scheduled = mocked.after.mock.calls[0]![0] as () => Promise<void>;
    await scheduled();
    expect(mocked.processQueuedAgentJobs).toHaveBeenCalledWith({ requestedJobId: "job-1" });
  });

  it("rejects incomplete onboarding before inserting a session", async () => {
    setupAccess({ onboardingRow: { status: "in_progress" } });

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(409);
    expect(currentAdminMock.insertedSessions).toHaveLength(0);
    expect(mocked.enqueueWallieRun).not.toHaveBeenCalled();
  });

  it("rejects missing default pipeline or first stage", async () => {
    setupAccess({ pipelineRow: null });
    const missingPipeline = await POST(
      makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }),
    );
    expect(missingPipeline.status).toBe(409);

    setupAccess({ firstStageRow: null });
    const missingStage = await POST(
      makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }),
    );
    expect(missingStage.status).toBe(409);
  });

  it("deletes the created session if the first run cannot be queued", async () => {
    mocked.enqueueWallieRun.mockRejectedValueOnce(new Error("queue failed"));

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("could not queue the first run"),
    });
    expect(currentAdminMock.deletedSessionIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
