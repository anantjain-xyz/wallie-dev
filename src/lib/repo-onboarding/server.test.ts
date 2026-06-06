import { describe, expect, it, vi } from "vitest";

import {
  markRepositoryOnboardingReady,
  startRepositoryOnboarding,
} from "@/lib/repo-onboarding/server";
import { WALLIE_SKILL_VERSION, wallieSkillManifestHash } from "@/lib/repo-onboarding/skills";

function buildAdmin(input: {
  authorIdentityRow?: Record<string, unknown> | null;
  memberRow?: Record<string, unknown> | null;
  onboardingRow: Record<string, unknown> | null;
  repository?: Record<string, unknown>;
}) {
  const upserts: unknown[] = [];
  const memberRow = input.memberRow ?? {
    email: "anant@example.com",
    full_name: "Anant Jain",
    id: "member-1",
    user_id: "user-1",
  };
  const authorIdentityRow =
    input.authorIdentityRow === undefined
      ? {
          author_email: "12345+anant@users.noreply.github.com",
          author_email_source: "github_noreply",
          author_email_verified_at: "2026-05-16T18:00:00.000Z",
          author_name: "Anant Jain",
          connected_at: "2026-05-16T18:00:00.000Z",
          created_at: "2026-05-16T18:00:00.000Z",
          github_avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
          github_login: "anant",
          github_user_id: 12345,
          updated_at: "2026-05-16T18:00:00.000Z",
          user_id: "user-1",
        }
      : input.authorIdentityRow;
  const repository = input.repository ?? {
    default_branch: "main",
    full_name: "acme/app",
    github_installation_id: "installation-row-1",
    id: "repo-1",
    is_archived: false,
    name: "app",
    workspace_id: "ws-1",
  };

  const admin = {
    from(table: string) {
      return {
        select() {
          const chain = {
            eq() {
              return chain;
            },
            maybeSingle: async () => {
              if (table === "github_repositories") {
                return { data: repository, error: null };
              }
              if (table === "github_installations") {
                return { data: { installation_id: 123 }, error: null };
              }
              if (table === "repository_onboarding_status") {
                return { data: input.onboardingRow, error: null };
              }
              if (table === "workspace_members") {
                return { data: memberRow, error: null };
              }
              if (table === "user_github_identities") {
                return { data: authorIdentityRow, error: null };
              }
              throw new Error(`unexpected select from ${table}`);
            },
          };
          return chain;
        },
        upsert(values: unknown) {
          upserts.push(values);
          return {
            select: () => ({
              single: async () => ({ data: values, error: null }),
            }),
          };
        },
      };
    },
  };

  return { admin, upserts };
}

describe("startRepositoryOnboarding", () => {
  it("reuses an in-flight setup PR instead of opening duplicates", async () => {
    const { admin, upserts } = buildAdmin({
      onboardingRow: {
        conflict_report: [{ path: ".agents/skills/push/SKILL.md" }],
        github_repository_id: "repo-1",
        installed_skill_hash: null,
        installed_skill_version: null,
        last_error: null,
        setup_branch_name: "wallie/setup-app-existing",
        setup_pr_number: 12,
        setup_pr_url: "https://github.com/acme/app/pull/12",
        status: "conflict",
        updated_at: "2026-05-15T00:00:00.000Z",
      },
    });
    const requests: string[] = [];
    const octokit = {
      request: vi.fn(async (route: string) => {
        requests.push(route);
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          throw { status: 404 };
        }
        throw new Error(`unexpected GitHub request: ${route}`);
      }),
    };

    const result = await startRepositoryOnboarding({
      admin: admin as never,
      githubAppFactory: () => ({
        getInstallationOctokit: async () => octokit as never,
      }),
      repositoryId: "repo-1",
      requestedByMemberId: "member-1",
      workspaceId: "ws-1",
    });

    expect(result.onboarding).toMatchObject({
      setupBranchName: "wallie/setup-app-existing",
      setupPrNumber: 12,
      setupPrUrl: "https://github.com/acme/app/pull/12",
      status: "conflict",
    });
    expect(requests.every((route) => route === "GET /repos/{owner}/{repo}/contents/{path}")).toBe(
      true,
    );
    expect(octokit.request).not.toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.anything(),
    );
    expect(upserts).toHaveLength(0);
  });

  it("creates setup commits with the requester's GitHub author identity", async () => {
    const { admin, upserts } = buildAdmin({
      onboardingRow: null,
    });
    const commitParams: Array<Record<string, unknown>> = [];
    const octokit = {
      request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          throw { status: 404 };
        }
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          return { data: { object: { sha: "base-sha" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: "base-tree" } } };
        }
        if (route === "POST /repos/{owner}/{repo}/git/trees") {
          return { data: { sha: "tree-sha" } };
        }
        if (route === "POST /repos/{owner}/{repo}/git/commits") {
          commitParams.push(params ?? {});
          return { data: { sha: "commit-sha" } };
        }
        if (route === "POST /repos/{owner}/{repo}/git/refs") {
          return { data: {} };
        }
        if (route === "POST /repos/{owner}/{repo}/pulls") {
          return { data: { html_url: "https://github.com/acme/app/pull/12", number: 12 } };
        }
        throw new Error(`unexpected GitHub request: ${route}`);
      }),
    };

    const result = await startRepositoryOnboarding({
      admin: admin as never,
      githubAppFactory: () => ({
        getInstallationOctokit: async () => octokit as never,
      }),
      repositoryId: "repo-1",
      requestedByMemberId: "member-1",
      workspaceId: "ws-1",
    });

    expect(result.onboarding).toMatchObject({
      setupPrNumber: 12,
      setupPrUrl: "https://github.com/acme/app/pull/12",
      status: "pr_open",
    });
    expect(commitParams).toHaveLength(1);
    expect(commitParams[0]).toMatchObject({
      author: {
        email: "12345+anant@users.noreply.github.com",
        name: "Anant Jain",
      },
      message: "chore: set up Wallie workflow skills",
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      setup_pr_number: 12,
      status: "pr_open",
    });
  });

  it("blocks setup PR creation when the requester has no GitHub author identity", async () => {
    const { admin, upserts } = buildAdmin({
      authorIdentityRow: null,
      onboardingRow: null,
    });
    const requests: string[] = [];
    const octokit = {
      request: vi.fn(async (route: string) => {
        requests.push(route);
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          throw { status: 404 };
        }
        throw new Error(`unexpected GitHub request: ${route}`);
      }),
    };

    await expect(
      startRepositoryOnboarding({
        admin: admin as never,
        githubAppFactory: () => ({
          getInstallationOctokit: async () => octokit,
        }),
        repositoryId: "repo-1",
        requestedByMemberId: "member-1",
        workspaceId: "ws-1",
      }),
    ).rejects.toMatchObject({
      code: "github_author_missing",
      statusCode: 409,
    });

    expect(requests).not.toContain("POST /repos/{owner}/{repo}/git/commits");
    expect(requests).not.toContain("POST /repos/{owner}/{repo}/pulls");
    expect(upserts).toHaveLength(0);
  });
});

describe("markRepositoryOnboardingReady", () => {
  it("records a manual ready state for a valid repository", async () => {
    const { admin, upserts } = buildAdmin({
      onboardingRow: null,
    });

    const result = await markRepositoryOnboardingReady({
      admin: admin as never,
      repositoryId: "repo-1",
      workspaceId: "ws-1",
    });

    expect(result.onboarding).toMatchObject({
      conflictReport: [],
      githubRepositoryId: "repo-1",
      installedSkillHash: wallieSkillManifestHash(),
      installedSkillVersion: WALLIE_SKILL_VERSION,
      lastError: null,
      setupBranchName: null,
      setupPrNumber: null,
      setupPrUrl: null,
      status: "ready",
    });
    expect(upserts).toMatchObject([
      {
        conflict_report: [],
        github_repository_id: "repo-1",
        installed_skill_hash: wallieSkillManifestHash(),
        installed_skill_version: WALLIE_SKILL_VERSION,
        last_error: null,
        setup_branch_name: null,
        setup_pr_number: null,
        setup_pr_url: null,
        status: "ready",
        workspace_id: "ws-1",
      },
    ]);
  });
});
