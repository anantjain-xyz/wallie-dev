import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  getWorkspaceBySlugForUser: vi.fn(),
  hasAnyWorkspaceForUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocked.notFound,
  redirect: mocked.redirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/auth", () => ({
  ensureProfileForUser: mocked.ensureProfileForUser,
  getWorkspaceBySlugForUser: mocked.getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser: mocked.hasAnyWorkspaceForUser,
  workspaceLoginRedirectPath: (workspaceSlug: string) => `/w/${workspaceSlug}`,
}));

import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

const user = { email: "owner@example.com", id: "user-1" };
const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };

function buildSupabaseMock(
  onboardingRow: {
    current_step: string;
    selected_github_repository_id?: string | null;
    status: string;
  } | null = {
    current_step: "github",
    selected_github_repository_id: null,
    status: "dismissed",
  },
  opts: {
    primaryRepositoryId?: string | null;
    repositories?: Array<{ full_name: string; id: string; is_archived?: boolean }>;
  } = {},
) {
  return {
    from: vi.fn((table: string) => {
      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: onboardingRow, error: null }),
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
            const builder = {
              eq: () => builder,
              order: () => builder,
              range: async (from: number, to: number) => ({
                data: (opts.repositories ?? [])
                  .filter((repository) => !repository.is_archived)
                  .sort((left, right) => left.full_name.localeCompare(right.full_name))
                  .slice(from, to + 1)
                  .map((repository) => ({
                    full_name: repository.full_name,
                    id: repository.id,
                  })),
                error: null,
              }),
            };
            return builder;
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    }),
  };
}

describe("loadWorkspaceLayoutContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to login with the workspace next path", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    await expect(loadWorkspaceLayoutContext("unauth-workspace")).rejects.toThrow(
      "redirect:/login?next=%2Fw%2Funauth-workspace",
    );
  });

  it("redirects to workspace onboarding when no workspace exists for the user", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(false);

    await expect(loadWorkspaceLayoutContext("missing-empty")).rejects.toThrow(
      "redirect:/onboarding/workspace",
    );
  });

  it("returns not found for a missing workspace when the user has another workspace", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(true);

    await expect(loadWorkspaceLayoutContext("missing-owned")).rejects.toThrow("not-found");
  });

  it("ensures the user profile and returns member workspace context", async () => {
    const supabase = buildSupabaseMock(
      {
        current_step: "repository",
        selected_github_repository_id: "repo-b",
        status: "in_progress",
      },
      {
        primaryRepositoryId: "repo-a",
        repositories: [
          { full_name: "acme/api", id: "repo-a" },
          { full_name: "acme/web", id: "repo-b" },
        ],
      },
    );
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toEqual({
      onboarding: {
        currentStep: "repository",
        status: "in_progress",
      },
      defaultSessionGithubRepositoryId: "repo-a",
      sessionRepositoryOptions: [
        { fullName: "acme/api", id: "repo-a" },
        { fullName: "acme/web", id: "repo-b" },
      ],
      supabase,
      user,
      workspace,
    });
    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith(supabase, user);
  });

  it("loads repository picker options across pages", async () => {
    const repositories = Array.from({ length: 1001 }, (_, index) => ({
      full_name: `acme/repo-${index.toString().padStart(4, "0")}`,
      id: `repo-${index}`,
    }));
    const supabase = buildSupabaseMock(
      {
        current_step: "verify",
        selected_github_repository_id: "repo-0",
        status: "completed",
      },
      {
        primaryRepositoryId: "repo-1000",
        repositories,
      },
    );
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    const context = await loadWorkspaceLayoutContext("member-access");

    expect(context.defaultSessionGithubRepositoryId).toBe("repo-1000");
    expect(context.sessionRepositoryOptions).toHaveLength(1001);
    expect(context.sessionRepositoryOptions.at(-1)).toEqual({
      fullName: "acme/repo-1000",
      id: "repo-1000",
    });
  });

  it("treats a missing onboarding row as setup-required state", async () => {
    const supabase = buildSupabaseMock(null);
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    await expect(loadWorkspaceLayoutContext("legacy-workspace")).resolves.toMatchObject({
      onboarding: {
        currentStep: "github",
        status: "not_started",
      },
    });
  });
});
