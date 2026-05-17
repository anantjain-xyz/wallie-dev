import { describe, expect, it } from "vitest";

import { primaryProfileForRepositories } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function profile(repositoryId: string): RepositoryProfileState {
  return {
    buildCommand: null,
    createdAt: null,
    envKeySuggestions: [],
    frameworkHints: [],
    githubRepositoryId: repositoryId,
    id: "profile-1",
    inferenceConfidence: "high",
    inferenceSources: [],
    installCommand: "pnpm install",
    isPrimary: true,
    languageHints: ["TypeScript"],
    packageManager: "pnpm",
    setupNotes: "",
    testCommand: "pnpm test",
    updatedAt: null,
    workspaceId: WORKSPACE_ID,
  };
}

function repository(id: string, profileState: RepositoryProfileState | null) {
  return {
    defaultBranch: "main",
    defaultProgrammingLanguage: "TypeScript",
    description: null,
    fullName: `acme/${id}`,
    htmlUrl: `https://github.com/acme/${id}`,
    id,
    isArchived: false,
    isPrivate: true,
    name: id,
    onboarding: {
      conflictReport: [],
      githubRepositoryId: id,
      installedSkillHash: null,
      installedSkillVersion: null,
      lastError: null,
      setupBranchName: null,
      setupPrNumber: null,
      setupPrUrl: null,
      status: "not_set_up" as const,
      updatedAt: null,
    },
    profile: profileState,
    repoId: 100,
  } satisfies WorkspaceGitHubRepository;
}

describe("primaryProfileForRepositories", () => {
  it("keeps the primary profile when the refreshed repositories still include it", () => {
    const primary = profile("repo-1");

    expect(
      primaryProfileForRepositories({ primaryProfile: primary }, [
        repository("repo-1", primary),
        repository("repo-2", null),
      ]),
    ).toBe(primary);
  });

  it("clears the primary profile when refresh drops the selected repository", () => {
    expect(
      primaryProfileForRepositories({ primaryProfile: profile("repo-1") }, [
        repository("repo-2", null),
      ]),
    ).toBeNull();
  });
});
