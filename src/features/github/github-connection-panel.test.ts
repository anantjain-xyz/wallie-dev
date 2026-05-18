import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GitHubConnectionPanel,
  mergeRefreshedRepositories,
  mergeRepositoryOnboardingState,
  primaryProfileForRepositories,
} from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData } from "@/features/github/data";
import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
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

function readyOnboarding(repositoryId: string): RepositoryOnboardingState {
  return {
    conflictReport: [],
    githubRepositoryId: repositoryId,
    installedSkillHash: "hash-1",
    installedSkillVersion: 1,
    lastError: null,
    setupBranchName: null,
    setupPrNumber: null,
    setupPrUrl: null,
    status: "ready",
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
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

describe("mergeRefreshedRepositories", () => {
  it("preserves the latest onboarding and profile state when refresh returns repository summaries", () => {
    const primary = profile("repo-1");
    const current = {
      ...repository("repo-1", primary),
      onboarding: readyOnboarding("repo-1"),
    };
    const refreshed = {
      ...repository("repo-1", null),
      defaultBranch: "trunk",
      fullName: "acme/repo-1-renamed",
    };

    const [next] = mergeRefreshedRepositories([refreshed], [current]);

    expect(next.fullName).toBe("acme/repo-1-renamed");
    expect(next.defaultBranch).toBe("trunk");
    expect(next.onboarding).toBe(current.onboarding);
    expect(next.profile).toBe(primary);
  });
});

describe("mergeRepositoryOnboardingState", () => {
  it("patches setup state without dropping repositories added by a newer refresh", () => {
    const repo1 = repository("repo-1", null);
    const repo2 = repository("repo-2", null);
    const nextOnboarding = readyOnboarding("repo-1");

    const nextRepositories = mergeRepositoryOnboardingState(
      [repo1, repo2],
      "repo-1",
      nextOnboarding,
    );

    expect(nextRepositories).toHaveLength(2);
    expect(nextRepositories[0]?.onboarding).toBe(nextOnboarding);
    expect(nextRepositories[1]).toBe(repo2);
  });
});

describe("GitHubConnectionPanel", () => {
  it("does not render a duplicate Selected button for the selected repository", () => {
    const repo1 = repository("repo-1", null);
    const repo2 = repository("repo-2", null);
    const github = {
      installation: {
        appId: 123,
        id: "installation-1",
        installationId: 456,
        installationUrl: "https://github.com/settings/installations/456",
        permissions: {},
        suspended: false,
        targetName: "acme",
        targetType: "Organization",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [repo1, repo2],
    } satisfies WorkspaceGitHubData;

    const markup = renderToStaticMarkup(
      React.createElement(GitHubConnectionPanel, {
        canManage: true,
        github,
        onSelectRepository: () => undefined,
        selectedRepositoryId: repo1.id,
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(markup).toContain("Selected");
    expect(markup).toContain(">Select</button>");
    expect(markup).not.toContain(">Selected</button>");
  });

  it("can scope setup actions to only the selected repository", () => {
    const repo1 = repository("repo-1", null);
    const repo2 = repository("repo-2", null);
    const github = {
      installation: {
        appId: 123,
        id: "installation-1",
        installationId: 456,
        installationUrl: "https://github.com/settings/installations/456",
        permissions: {},
        suspended: false,
        targetName: "acme",
        targetType: "Organization",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [repo1, repo2],
    } satisfies WorkspaceGitHubData;

    const selectedOnly = renderToStaticMarkup(
      React.createElement(GitHubConnectionPanel, {
        canManage: true,
        github,
        onSelectRepository: () => undefined,
        selectedRepositoryId: repo1.id,
        setupActionScope: "selected",
        workspaceId: WORKSPACE_ID,
      }),
    );
    const hidden = renderToStaticMarkup(
      React.createElement(GitHubConnectionPanel, {
        canManage: true,
        github,
        setupActionScope: "none",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(selectedOnly.match(/>Set up Wallie<\/button>/g) ?? []).toHaveLength(1);
    expect(hidden).not.toContain("Set up Wallie");
  });

  it("renders manual setup completion only when explicitly enabled", () => {
    const repo1 = repository("repo-1", null);
    const github = {
      installation: {
        appId: 123,
        id: "installation-1",
        installationId: 456,
        installationUrl: "https://github.com/settings/installations/456",
        permissions: {},
        suspended: false,
        targetName: "acme",
        targetType: "Organization",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [repo1],
    } satisfies WorkspaceGitHubData;

    const enabled = renderToStaticMarkup(
      React.createElement(GitHubConnectionPanel, {
        allowManualSetupComplete: true,
        canManage: true,
        github,
        onSelectRepository: () => undefined,
        selectedRepositoryId: repo1.id,
        setupActionScope: "selected",
        workspaceId: WORKSPACE_ID,
      }),
    );
    const disabled = renderToStaticMarkup(
      React.createElement(GitHubConnectionPanel, {
        canManage: true,
        github,
        onSelectRepository: () => undefined,
        selectedRepositoryId: repo1.id,
        setupActionScope: "selected",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(enabled).toContain("Mark setup complete");
    expect(disabled).not.toContain("Mark setup complete");
  });
});
