import { describe, expect, it, vi } from "vitest";

import { resolveEffectiveSessionRepository } from "./effective-repository";

const WORKSPACE_ID = "ws-1";
const SESSION_ID = "sess-1";

type Repo = {
  default_branch: string | null;
  default_programming_language: string | null;
  full_name: string;
  github_installation_id: string;
  html_url: string;
  id: string;
  is_archived: boolean;
  private: boolean;
  workspace_id: string;
};

function repo(id: string, fullName: string, overrides: Partial<Repo> = {}): Repo {
  return {
    default_branch: "main",
    default_programming_language: "TypeScript",
    full_name: fullName,
    github_installation_id: "ghi-1",
    html_url: `https://github.com/${fullName}`,
    id,
    is_archived: false,
    private: false,
    workspace_id: WORKSPACE_ID,
    ...overrides,
  };
}

function buildSupabaseMock(input: {
  onboardingRepositoryId?: string | null;
  primaryRepositoryId?: string | null;
  pullRequestRepositoryId?: string | null;
  repositories?: Repo[];
  repositoryError?: { message: string; code?: string };
  sessionRepositoryId?: string | null;
}) {
  const repositories = input.repositories ?? [];

  return {
    from(table: string) {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: input.sessionRepositoryId
                    ? { github_repository_id: input.sessionRepositoryId }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "session_pull_requests") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: input.pullRequestRepositoryId
                        ? { github_repository_id: input.pullRequestRepositoryId }
                        : null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "workspace_repository_profiles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: input.primaryRepositoryId
                    ? { github_repository_id: input.primaryRepositoryId }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: input.onboardingRepositoryId
                  ? { selected_github_repository_id: input.onboardingRepositoryId }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "github_repositories") {
        return {
          select: () => {
            const filters = new Map<string, unknown>();
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              maybeSingle: async () => ({
                data:
                  repositories.find(
                    (candidate) =>
                      candidate.id === filters.get("id") &&
                      candidate.workspace_id === filters.get("workspace_id"),
                  ) ?? null,
                error: input.repositoryError ?? null,
              }),
            };

            return builder;
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("resolveEffectiveSessionRepository", () => {
  it("keeps a text-only session on its job's pinned repository despite newer PR and workspace defaults", async () => {
    const supabase = buildSupabaseMock({
      primaryRepositoryId: "repo-new-primary",
      pullRequestRepositoryId: "repo-new-pr",
      onboardingRepositoryId: "repo-onboarding",
      repositories: [
        repo("repo-job", "acme/reviewed", { default_branch: "release", private: true }),
        repo("repo-new-primary", "acme/new-primary"),
        repo("repo-new-pr", "acme/new-pr"),
        repo("repo-onboarding", "acme/onboarding"),
      ],
    });
    const from = vi.spyOn(supabase, "from");

    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: supabase as never,
      workspaceId: WORKSPACE_ID,
      pinnedRepositoryId: "repo-job",
    });

    expect(resolution).toMatchObject({
      source: "job_git_input",
      repositoryId: "repo-job",
      repository: {
        id: "repo-job",
        fullName: "acme/reviewed",
        defaultBranch: "release",
        isPrivate: true,
        isArchived: false,
      },
    });
    expect(from.mock.calls).toEqual([["github_repositories"]]);
  });

  it.each(["missing", "another workspace"])(
    "preserves an unresolved job pin from %s without using any available fallback",
    async (state) => {
      const supabase = buildSupabaseMock({
        sessionRepositoryId: "repo-session",
        primaryRepositoryId: "repo-primary",
        pullRequestRepositoryId: "repo-pr",
        onboardingRepositoryId: "repo-onboarding",
        repositories: [
          repo("repo-session", "acme/session"),
          repo("repo-primary", "acme/primary"),
          repo("repo-pr", "acme/pr"),
          repo("repo-onboarding", "acme/onboarding"),
          ...(state === "another workspace"
            ? [repo("repo-job", "other-workspace/private", { workspace_id: "ws-2" })]
            : []),
        ],
      });
      const from = vi.spyOn(supabase, "from");

      const resolution = await resolveEffectiveSessionRepository({
        sessionId: SESSION_ID,
        supabase: supabase as never,
        workspaceId: WORKSPACE_ID,
        pinnedRepositoryId: "repo-job",
      });

      expect(resolution).toEqual({
        repository: null,
        repositoryId: "repo-job",
        source: "job_git_input",
      });
      expect(from.mock.calls).toEqual([["github_repositories"]]);
    },
  );

  it("preserves the pinned repository's archived state instead of silently choosing an active default", async () => {
    const supabase = buildSupabaseMock({
      primaryRepositoryId: "repo-active",
      pullRequestRepositoryId: "repo-active",
      repositories: [
        repo("repo-job", "acme/archived", { is_archived: true }),
        repo("repo-active", "acme/active"),
      ],
    });
    const from = vi.spyOn(supabase, "from");

    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: supabase as never,
      workspaceId: WORKSPACE_ID,
      pinnedRepositoryId: "repo-job",
    });

    expect(resolution).toMatchObject({
      repositoryId: "repo-job",
      source: "job_git_input",
      repository: { id: "repo-job", fullName: "acme/archived", isArchived: true },
    });
    expect(from.mock.calls).toEqual([["github_repositories"]]);
  });

  it("propagates a pinned repository lookup failure without trying workspace defaults", async () => {
    const error = { message: "Pinned repository lookup failed", code: "DB_UNAVAILABLE" };
    const supabase = buildSupabaseMock({
      repositoryError: error,
      primaryRepositoryId: "repo-primary",
      repositories: [repo("repo-primary", "acme/primary")],
    });
    const from = vi.spyOn(supabase, "from");

    await expect(
      resolveEffectiveSessionRepository({
        sessionId: SESSION_ID,
        supabase: supabase as never,
        workspaceId: WORKSPACE_ID,
        pinnedRepositoryId: "repo-job",
      }),
    ).rejects.toBe(error);
    expect(from.mock.calls).toEqual([["github_repositories"]]);
  });

  it("uses the pinned session repository before pull request and workspace fallbacks", async () => {
    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: buildSupabaseMock({
        primaryRepositoryId: "repo-primary",
        pullRequestRepositoryId: "repo-pr",
        repositories: [
          repo("repo-primary", "acme/primary"),
          repo("repo-pr", "acme/pr"),
          repo("repo-session", "acme/session"),
        ],
        sessionRepositoryId: "repo-session",
      }) as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(resolution.source).toBe("session");
    expect(resolution.repository?.fullName).toBe("acme/session");
  });

  it("uses the latest session pull request repository before the workspace primary", async () => {
    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: buildSupabaseMock({
        primaryRepositoryId: "repo-primary",
        pullRequestRepositoryId: "repo-pr",
        repositories: [repo("repo-primary", "acme/primary"), repo("repo-pr", "acme/session")],
      }) as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(resolution.source).toBe("session_pull_request");
    expect(resolution.repository?.fullName).toBe("acme/session");
  });

  it("uses the workspace profile repository before onboarding fallback", async () => {
    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: buildSupabaseMock({
        onboardingRepositoryId: "repo-onboarding",
        primaryRepositoryId: "repo-primary",
        repositories: [repo("repo-primary", "acme/primary"), repo("repo-onboarding", "acme/setup")],
      }) as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(resolution.source).toBe("workspace_primary_profile");
    expect(resolution.repository?.fullName).toBe("acme/primary");
  });

  it("falls back to onboarding selected repository", async () => {
    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: buildSupabaseMock({
        onboardingRepositoryId: "repo-onboarding",
        repositories: [repo("repo-onboarding", "acme/setup")],
      }) as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(resolution.source).toBe("workspace_onboarding");
    expect(resolution.repository?.fullName).toBe("acme/setup");
  });

  it("preserves the configured repository id when it does not resolve in the workspace", async () => {
    const resolution = await resolveEffectiveSessionRepository({
      sessionId: SESSION_ID,
      supabase: buildSupabaseMock({
        primaryRepositoryId: "repo-other-workspace",
        repositories: [repo("repo-other-workspace", "acme/other", { workspace_id: "ws-2" })],
      }) as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(resolution.repository).toBeNull();
    expect(resolution.repositoryId).toBe("repo-other-workspace");
    expect(resolution.source).toBe("workspace_primary_profile");
  });
});
