import { describe, expect, it } from "vitest";

import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function profile(repositoryId: string): RepositoryProfileState {
  return {
    buildCommand: null,
    createdAt: "2026-05-16T18:00:00.000Z",
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
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function repository(
  id: string,
  overrides: Partial<WorkspaceGitHubRepository> = {},
): WorkspaceGitHubRepository {
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
      status: "ready",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    profile: null,
    repoId: 100,
    ...overrides,
  };
}

function github(
  primaryProfile: RepositoryProfileState | null,
  repositories: WorkspaceGitHubRepository[],
): Pick<WorkspaceGitHubData, "primaryProfile" | "repositories"> {
  return { primaryProfile, repositories };
}

describe("buildRepositorySetupHealth", () => {
  it("marks a selected repository with a matching legacy profile as configured", () => {
    const primary = profile("repo-1");

    expect(
      buildRepositorySetupHealth(
        github(primary, [repository("repo-1", { profile: primary })]),
        "repo-1",
      ),
    ).toMatchObject({
      selectedRepository: {
        configured: true,
        fullName: "acme/repo-1",
        repositoryId: "repo-1",
        status: "ready",
      },
      primaryRepositoryProfile: {
        configured: true,
        fullName: "acme/repo-1",
        repositoryId: "repo-1",
        status: "ready",
      },
      repositorySetup: {
        configured: true,
        repositoryId: "repo-1",
        status: "ready",
      },
    });
  });

  it("treats a selected repository profile as missing when primary points elsewhere", () => {
    const primary = profile("repo-2");

    expect(
      buildRepositorySetupHealth(
        github(primary, [repository("repo-1"), repository("repo-2", { profile: primary })]),
        "repo-1",
      ),
    ).toMatchObject({
      selectedRepository: {
        configured: true,
        fullName: "acme/repo-1",
        repositoryId: "repo-1",
        status: "ready",
      },
      primaryRepositoryProfile: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      repositorySetup: {
        configured: true,
        repositoryId: "repo-1",
        status: "ready",
      },
    });
  });

  it("treats an archived selected repository as missing", () => {
    const primary = profile("repo-1");

    expect(
      buildRepositorySetupHealth(
        github(primary, [repository("repo-1", { isArchived: true, profile: primary })]),
        "repo-1",
      ),
    ).toMatchObject({
      selectedRepository: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      primaryRepositoryProfile: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      repositorySetup: {
        configured: false,
        repositoryId: null,
        status: "placeholder",
      },
    });
  });
});
