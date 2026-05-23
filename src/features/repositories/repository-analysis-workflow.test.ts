import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import { prepareRepositoryForAnalysis } from "@/features/repositories/repository-analysis-workflow";
import { sortRepositoriesForAnalysis } from "@/features/repositories/repository-setup-controls";
import type {
  RepositoryOnboardingState,
  RepositoryOnboardingStatus,
} from "@/lib/repo-onboarding/contracts";

function onboarding(
  repositoryId: string,
  status: RepositoryOnboardingStatus,
  overrides: Partial<RepositoryOnboardingState> = {},
): RepositoryOnboardingState {
  return {
    conflictReport: [],
    githubRepositoryId: repositoryId,
    installedSkillHash: status === "ready" ? "hash-1" : null,
    installedSkillVersion: status === "ready" ? 1 : null,
    lastError: null,
    setupBranchName: null,
    setupPrNumber: null,
    setupPrUrl: null,
    status,
    updatedAt: null,
    ...overrides,
  };
}

function repository(
  id: string,
  status: RepositoryOnboardingStatus,
  overrides: Partial<WorkspaceGitHubRepository> = {},
) {
  return {
    defaultBranch: "main",
    defaultProgrammingLanguage: "TypeScript",
    description: null,
    fullName: `acme/${id}`,
    htmlUrl: `https://github.com/acme/${id}`,
    id,
    isArchived: false,
    isPrivate: false,
    name: id,
    onboarding: onboarding(id, status),
    profile: null,
    repoId: 100,
    ...overrides,
  } satisfies WorkspaceGitHubRepository;
}

describe("repository analysis workflow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows ready repositories before setup-only repositories", () => {
    const sorted = sortRepositoriesForAnalysis([
      repository("needs-setup", "not_set_up"),
      repository("ready-app", "ready"),
      repository("also-needs-setup", "not_set_up"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["ready-app", "also-needs-setup", "needs-setup"]);
  });

  it("installs skills and marks a repository ready before analysis", async () => {
    const setupOnboarding = onboarding("repo-a", "pr_open", {
      setupBranchName: "wallie/setup-repo-a",
      setupPrNumber: 12,
      setupPrUrl: "https://github.com/acme/repo-a/pull/12",
    });
    const readyOnboarding = onboarding("repo-a", "ready");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({ onboarding: setupOnboarding });
      }
      if (init?.method === "PATCH") {
        return Response.json({ onboarding: readyOnboarding });
      }

      return Response.json({ error: "Unexpected request." }, { status: 500 });
    });
    const updates: RepositoryOnboardingState[] = [];
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareRepositoryForAnalysis({
        onChange: (_repositoryId, nextOnboarding) => updates.push(nextOnboarding),
        repository: repository("repo-a", "not_set_up"),
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual(readyOnboarding);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspaces/workspace-1/repositories/repo-a/onboarding",
      { method: "POST" },
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/workspaces/workspace-1/repositories/repo-a/onboarding",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ action: "mark_ready" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    expect(updates).toEqual([setupOnboarding, readyOnboarding]);
  });

  it("does not prepare repositories that are already ready", async () => {
    const fetchMock = vi.fn();
    const readyRepository = repository("repo-a", "ready");
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareRepositoryForAnalysis({
        onChange: () => undefined,
        repository: readyRepository,
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual(readyRepository.onboarding);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
