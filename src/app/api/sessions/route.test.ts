import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSessionWithFirstJob: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  prepareSessionFirstRun: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/wallie/service", () => ({
  createSessionWithFirstJob: mocked.createSessionWithFirstJob,
  prepareSessionFirstRun: mocked.prepareSessionFirstRun,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { POST } from "./route";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/sessions", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
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
    firstRepositoryId?: string | null;
    primaryRepositoryId?: string | null;
    repositoriesById?: Record<string, boolean>;
  } = {},
) {
  const repositoriesById = opts.repositoriesById ?? {};
  const firstRepositoryId = opts.firstRepositoryId ?? null;

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
            if (!scopedToWorkspace || !scopedToActive) {
              return { data: null, error: null };
            }

            if (selectedId) {
              return {
                data: repositoriesById[selectedId] ? { id: selectedId } : null,
                error: null,
              };
            }

            if (limited && firstRepositoryId) {
              return { data: { id: firstRepositoryId }, error: null };
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
        firstRepositoryId: REPOSITORY_ID,
        repositoriesById: { [REPOSITORY_ID]: true },
      }),
    );
    mocked.prepareSessionFirstRun.mockResolvedValue({ model: "gpt-5.5", provider: "codex" });
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
    const secondRepositoryId = "55555555-5555-4555-8555-555555555555";
    mocked.createSupabaseAdminClient.mockReturnValue(
      buildAdminMock({
        firstRepositoryId: REPOSITORY_ID,
        primaryRepositoryId: secondRepositoryId,
        repositoriesById: {
          [REPOSITORY_ID]: true,
          [secondRepositoryId]: true,
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
        githubRepositoryId: "66666666-6666-4666-8666-666666666666",
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(400);
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
