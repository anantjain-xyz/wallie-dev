import { beforeEach, describe, expect, it, vi } from "vitest";

import { WallieActionError } from "@/lib/wallie/service";

const mocked = vi.hoisted(() => ({
  assertSessionFirstRunReady: vi.fn(),
  createSessionWithFirstJob: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  loadSessionFirstRunPrerequisites: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/wallie/service", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/wallie/service")>("@/lib/wallie/service");
  return {
    WallieActionError: actual.WallieActionError,
    assertSessionFirstRunReady: mocked.assertSessionFirstRunReady,
    createSessionWithFirstJob: mocked.createSessionWithFirstJob,
    loadSessionFirstRunPrerequisites: mocked.loadSessionFirstRunPrerequisites,
  };
});

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { POST } from "./route";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";
const ARCHIVED_REPOSITORY_ID = "55555555-5555-4555-8555-555555555555";

type RepositoryRow = {
  default_branch: string | null;
  default_programming_language: string | null;
  full_name: string;
  html_url: string;
  id: string;
  is_archived: boolean;
  private: boolean;
};

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/sessions", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function makeRepository(id: string, isArchived = false): RepositoryRow {
  return {
    default_branch: "main",
    default_programming_language: "TypeScript",
    full_name: `acme/${id.slice(0, 8)}`,
    html_url: `https://github.com/acme/${id.slice(0, 8)}`,
    id,
    is_archived: isArchived,
    private: false,
  };
}

function buildSupabaseMock(
  onboardingRow: {
    selected_github_repository_id: string | null;
    status: string;
  } | null = { selected_github_repository_id: null, status: "completed" },
) {
  return {
    from(table: string) {
      if (table !== "workspace_onboarding") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: onboardingRow, error: null }) }),
        }),
      };
    },
  };
}

function buildAdminMock(
  opts: {
    firstRepository?: RepositoryRow | null;
    primaryRepositoryId?: string | null;
    repositoriesById?: Record<string, RepositoryRow>;
  } = {},
) {
  const repositoriesById = opts.repositoriesById ?? {};
  const firstRepository = opts.firstRepository ?? null;

  return {
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
        let selectedId: string | null = null;
        let scopedToWorkspace = false;
        let scopedToActive = false;
        let limited = false;

        const builder = {
          eq(column: string, value: string | boolean) {
            if (column === "id" && typeof value === "string") {
              selectedId = value;
            }
            if (column === "workspace_id") {
              scopedToWorkspace = value === WORKSPACE_ID;
            }
            if (column === "is_archived") {
              scopedToActive = value === false;
            }
            return builder;
          },
          limit(count: number) {
            limited = count === 1;
            return builder;
          },
          maybeSingle: async () => {
            if (!scopedToWorkspace) {
              return { data: null, error: null };
            }

            if (selectedId) {
              const repository = repositoriesById[selectedId] ?? null;
              if (!repository) {
                return { data: null, error: null };
              }
              if (scopedToActive && repository.is_archived) {
                return { data: null, error: null };
              }
              return { data: repository, error: null };
            }

            if (limited && scopedToActive && firstRepository && !firstRepository.is_archived) {
              return { data: firstRepository, error: null };
            }

            return { data: null, error: null };
          },
          order: () => builder,
          select: () => builder,
        };
        return builder;
      }

      throw new Error(`unexpected admin table ${table}`);
    },
  };
}

function setupAccess(onboardingRow?: Parameters<typeof buildSupabaseMock>[0]) {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role: "owner" },
      supabase: buildSupabaseMock(onboardingRow),
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });
}

describe("POST /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAccess();
    mocked.createSupabaseAdminClient.mockReturnValue(
      buildAdminMock({
        firstRepository: makeRepository(REPOSITORY_ID),
        repositoriesById: { [REPOSITORY_ID]: makeRepository(REPOSITORY_ID) },
      }),
    );
    mocked.loadSessionFirstRunPrerequisites.mockResolvedValue({
      agentConfig: { model: "gpt-5.5", provider: "codex" },
      missingSecretKeys: [],
      vercelSandboxConnection: {
        connected: true,
        lastValidationError: null,
        projectId: "prj_123",
        projectName: "wallie-sandboxes",
        status: "connected",
        teamId: "team_123",
      },
    });
    mocked.assertSessionFirstRunReady.mockImplementation(({ agentConfig }) => agentConfig);
    mocked.createSessionWithFirstJob.mockResolvedValue({
      jobId: "job-1",
      number: 7,
      runId: "run-1",
      sessionId: "session-1",
      workspaceSlug: "acme",
    });
  });

  it("creates the session and first job through one transactional service mutation", async () => {
    const response = await POST(
      makeRequest({
        linearIssueUrl: "https://linear.app/team/issue/TEAM-42/some-slug",
        promptMd: "Add SSO",
        title: "SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      canonicalUrl: "/w/acme/sessions/7",
      number: 7,
      processScheduled: true,
    });
    expect(mocked.assertSessionFirstRunReady).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({ id: REPOSITORY_ID, isArchived: false }),
      }),
    );
    expect(mocked.createSessionWithFirstJob).toHaveBeenCalledTimes(1);
    expect(mocked.createSessionWithFirstJob).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorMemberId: MEMBER_ID,
        githubRepositoryId: REPOSITORY_ID,
        linearIssueId: "TEAM-42",
        modelName: "gpt-5.5",
        modelProvider: "codex",
        promptMd: "Add SSO",
        title: "SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );
  });

  it("pins an explicitly selected repository via point lookup", async () => {
    const response = await POST(
      makeRequest({
        githubRepositoryId: REPOSITORY_ID,
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(201);
    expect(mocked.createSessionWithFirstJob).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepositoryId: REPOSITORY_ID }),
    );
  });

  it("prefers the primary workspace repository", async () => {
    const secondRepositoryId = "66666666-6666-4666-8666-666666666666";
    mocked.createSupabaseAdminClient.mockReturnValue(
      buildAdminMock({
        firstRepository: makeRepository(REPOSITORY_ID),
        primaryRepositoryId: secondRepositoryId,
        repositoriesById: {
          [REPOSITORY_ID]: makeRepository(REPOSITORY_ID),
          [secondRepositoryId]: makeRepository(secondRepositoryId),
        },
      }),
    );

    await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(mocked.createSessionWithFirstJob).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepositoryId: secondRepositoryId }),
    );
  });

  it("rejects unavailable or cross-workspace repositories before mutation", async () => {
    const response = await POST(
      makeRequest({
        githubRepositoryId: "77777777-7777-4777-8777-777777777777",
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocked.createSessionWithFirstJob).not.toHaveBeenCalled();
  });

  it("blocks create when the configured repository is archived and no active fallback exists", async () => {
    mocked.createSupabaseAdminClient.mockReturnValue(
      buildAdminMock({
        firstRepository: null,
        primaryRepositoryId: ARCHIVED_REPOSITORY_ID,
        repositoriesById: {
          [ARCHIVED_REPOSITORY_ID]: makeRepository(ARCHIVED_REPOSITORY_ID, true),
        },
      }),
    );
    mocked.assertSessionFirstRunReady.mockImplementation(() => {
      throw new WallieActionError({
        code: "repository_archived",
        message: "Wallie cannot start a run against an archived repository.",
        statusCode: 422,
      });
    });

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "repository_archived",
      error: "Wallie cannot start a run against an archived repository.",
    });
    expect(mocked.assertSessionFirstRunReady).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({
          id: ARCHIVED_REPOSITORY_ID,
          isArchived: true,
        }),
      }),
    );
    expect(mocked.createSessionWithFirstJob).not.toHaveBeenCalled();
  });

  it("rejects incomplete onboarding before mutation", async () => {
    setupAccess({ selected_github_repository_id: null, status: "in_progress" });

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(409);
    expect(mocked.createSessionWithFirstJob).not.toHaveBeenCalled();
  });

  it("does not attempt compensating writes when the transaction fails", async () => {
    mocked.createSessionWithFirstJob.mockRejectedValueOnce(new Error("queue failed"));

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "queue failed" });
    expect(mocked.createSessionWithFirstJob).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when the transaction cannot resolve a pipeline stage", async () => {
    mocked.createSessionWithFirstJob.mockRejectedValueOnce({
      code: "P0002",
      message: "Workspace has no selected or default pipeline configured",
    });

    const response = await POST(makeRequest({ promptMd: "Add SSO", workspaceId: WORKSPACE_ID }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace has no selected or default pipeline configured",
    });
  });
});
