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
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";
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
  };
}

function buildAdminMock(
  opts: {
    nextNumber?: number;
    numberError?: { message: string } | null;
    primaryRepositoryId?: string | null;
    repositories?: Array<{
      full_name: string;
      id: string;
      is_archived?: boolean;
      workspace_id?: string;
    }>;
    sessionDeleteError?: { message: string } | null;
    sessionInsertError?: { message: string } | null;
  } = {},
) {
  const insertedSessions: Array<Record<string, unknown>> = [];
  const deletedSessionIds: string[] = [];
  const rpcCalls: Array<{ args: Record<string, unknown>; fn: string }> = [];

  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ args, fn });
      if (fn !== "next_session_number") {
        throw new Error(`unexpected admin rpc ${fn}`);
      }
      return { data: opts.nextNumber ?? 7, error: opts.numberError ?? null };
    },
    from(table: string) {
      if (table === "workspace_repository_profiles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.primaryRepositoryId
                    ? { github_repository_id: opts.primaryRepositoryId }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "github_repositories") {
        return {
          select: () => {
            const filters = new Map<string, unknown>();
            const matchingRepositories = () =>
              (opts.repositories ?? [])
                .filter((repository) => {
                  if (filters.has("id") && repository.id !== filters.get("id")) return false;
                  if (
                    filters.has("workspace_id") &&
                    (repository.workspace_id ?? WORKSPACE_ID) !== filters.get("workspace_id")
                  ) {
                    return false;
                  }
                  if (
                    filters.has("is_archived") &&
                    Boolean(repository.is_archived) !== filters.get("is_archived")
                  ) {
                    return false;
                  }
                  return true;
                })
                .sort((left, right) => left.full_name.localeCompare(right.full_name));
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              maybeSingle: async () => ({
                data: matchingRepositories()[0] ? { id: matchingRepositories()[0]!.id } : null,
                error: null,
              }),
              limit: () => builder,
              order: () => builder,
            };
            return builder;
          },
        };
      }

      if (table !== "sessions") {
        throw new Error(`unexpected admin table ${table}`);
      }
      return {
        delete: () => ({
          eq: async (_column: string, value: string) => {
            deletedSessionIds.push(value);
            return { error: opts.sessionDeleteError ?? null };
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

  return { admin, deletedSessionIds, insertedSessions, rpcCalls };
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
    expect(currentAdminMock.rpcCalls).toEqual([
      {
        args: {
          actor_user_id: "user-1",
          target_workspace_id: WORKSPACE_ID,
        },
        fn: "next_session_number",
      },
    ]);
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

  it("pins the selected repository on the created session", async () => {
    currentAdminMock = buildAdminMock({
      repositories: [{ full_name: "acme/app", id: REPOSITORY_ID }],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);

    const response = await POST(
      makeRequest({
        githubRepositoryId: REPOSITORY_ID,
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(201);
    expect(currentAdminMock.insertedSessions[0]).toMatchObject({
      github_repository_id: REPOSITORY_ID,
    });
  });

  it("defaults the session repository from the workspace primary repository", async () => {
    currentAdminMock = buildAdminMock({
      primaryRepositoryId: REPOSITORY_ID,
      repositories: [
        { full_name: "acme/app", id: REPOSITORY_ID },
        { full_name: "acme/web", id: "55555555-5555-4555-8555-555555555555" },
      ],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(201);
    expect(currentAdminMock.insertedSessions[0]).toMatchObject({
      github_repository_id: REPOSITORY_ID,
    });
  });

  it("rejects repository ids that are archived or outside the workspace", async () => {
    currentAdminMock = buildAdminMock({
      repositories: [
        { full_name: "acme/archived", id: REPOSITORY_ID, is_archived: true },
        {
          full_name: "other/app",
          id: "66666666-6666-4666-8666-666666666666",
          workspace_id: "77777777-7777-4777-8777-777777777777",
        },
      ],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);

    const archived = await POST(
      makeRequest({
        githubRepositoryId: REPOSITORY_ID,
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );
    const otherWorkspace = await POST(
      makeRequest({
        githubRepositoryId: "66666666-6666-4666-8666-666666666666",
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(archived.status).toBe(400);
    expect(otherWorkspace.status).toBe(400);
    expect(currentAdminMock.insertedSessions).toHaveLength(0);
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

  it("reports clearly when enqueue fails and the created session cannot be cleaned up", async () => {
    mocked.enqueueWallieRun.mockRejectedValueOnce(new Error("queue failed"));
    currentAdminMock = buildAdminMock({
      sessionDeleteError: { message: "delete failed" },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(currentAdminMock.admin);

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: expect.stringContaining("created session could not be cleaned up"),
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(body.error).not.toContain("Session was not created");
    expect(currentAdminMock.deletedSessionIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
