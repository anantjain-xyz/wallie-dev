import { describe, expect, it, vi } from "vitest";

import {
  markRepositoryOnboardingReady,
  startRepositoryOnboarding,
} from "@/lib/repo-onboarding/server";
import { WALLIE_SKILL_VERSION, wallieSkillManifestHash } from "@/lib/repo-onboarding/skills";

function buildAdmin(input: {
  onboardingRow: Record<string, unknown> | null;
  repository?: Record<string, unknown>;
}) {
  const upserts: unknown[] = [];
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
        getInstallationOctokit: async () => octokit,
      }),
      repositoryId: "repo-1",
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
