import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import RepositoryAnalysisStep from "@/features/onboarding/steps/repository-step";
import {
  RepositoryMetadata,
  RepositorySetupStatus,
} from "@/features/repositories/repository-setup-controls";
import { CURRENT_WALLIE_SKILL_VERSION } from "@/lib/repo-onboarding/contracts";
import type { RepositoryOnboardingStatus } from "@/lib/repo-onboarding/contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function repository(
  id: string,
  overrides: Partial<WorkspaceGitHubRepository> = {},
): WorkspaceGitHubRepository {
  const { onboarding: onboardingOverride, ...rest } = overrides;
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
    onboarding: {
      conflictReport: [],
      githubRepositoryId: id,
      installedSkillHash: null,
      installedSkillVersion: null,
      lastError: null,
      setupBranchName: null,
      setupPrNumber: null,
      setupPrUrl: null,
      status: "not_set_up",
      updatedAt: null,
      ...onboardingOverride,
    },
    profile: null,
    repoId: 100,
    ...rest,
  };
}

function metadataMarkup(overrides: Partial<WorkspaceGitHubRepository> = {}) {
  return renderToStaticMarkup(
    createElement(RepositoryMetadata, { repository: repository("app", overrides) }),
  );
}

function statusMarkup(status: RepositoryOnboardingStatus) {
  return renderToStaticMarkup(createElement(RepositorySetupStatus, { status }));
}

function cardMarkup(
  status: RepositoryOnboardingStatus,
  overrides: Partial<WorkspaceGitHubRepository> = {},
) {
  const selectedId = "app";
  const repo = repository(selectedId, {
    ...overrides,
    onboarding: {
      conflictReport:
        status === "conflict"
          ? [
              {
                message: "Differs",
                path: ".agents/skills/push/SKILL.md",
                reason: "existing_skill_differs",
              },
            ]
          : [],
      githubRepositoryId: selectedId,
      installedSkillHash: status === "ready" ? "hash-1" : null,
      installedSkillVersion: status === "ready" ? CURRENT_WALLIE_SKILL_VERSION : null,
      lastError: status === "error" ? "GitHub read failed" : null,
      setupBranchName: status === "pr_open" ? "wallie/setup-app" : null,
      setupPrNumber: status === "pr_open" ? 12 : null,
      setupPrUrl: status === "pr_open" ? "https://github.com/acme/app/pull/12" : null,
      status,
      updatedAt: null,
      ...overrides.onboarding,
    },
  });

  return renderToStaticMarkup(
    createElement(RepositoryAnalysisStep, {
      data: {
        canManage: true,
        github: {
          installation: null,
          missingAppKeys: [],
          missingWebhookKeys: [],
          primaryProfile: null,
          repositories: [repo],
        },
        onboarding: { selectedGithubRepositoryId: selectedId },
        workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
      } as unknown as WorkspaceOnboardingData,
      isSaving: false,
      onCompleteStep: vi.fn(),
      onDataChange: vi.fn(),
      onPipelineCompleted: vi.fn(),
      onRefresh: vi.fn(),
      onRepositoryOnboardingChange: vi.fn(),
      onRepositorySetupMessage: vi.fn(),
      onRuntimeStateChange: vi.fn(),
      onSelectGithubRepository: vi.fn(),
      onSelectStep: vi.fn(),
    }),
  );
}

describe("RepositoryMetadata", () => {
  it("renders a borderless wrapping line in language, branch, visibility order", () => {
    const html = metadataMarkup();

    expect(html).toContain('class="flex flex-wrap items-center gap-x-3 gap-y-1"');
    expect(html).not.toContain("border");
    expect(html).not.toContain("bg-canvas");
    expect(html).toMatch(
      /aria-label="Language: TypeScript"[\s\S]*aria-label="Default branch: main"[\s\S]*aria-label="Visibility: Public"/,
    );
    expect(html).toContain(
      'class="min-w-0 break-words text-[13px] font-medium leading-5 text-foreground font-mono"',
    );
    expect(html).not.toContain("Archived");
    expect(html).not.toContain('aria-label="Status: Archived"');
  });

  it("renders Archived as a fourth item only when the repository is archived", () => {
    const archived = metadataMarkup({ isArchived: true });
    const active = metadataMarkup({ isArchived: false });

    expect(archived).toMatch(
      /aria-label="Language: TypeScript"[\s\S]*aria-label="Default branch: main"[\s\S]*aria-label="Visibility: Public"[\s\S]*aria-label="Status: Archived"/,
    );
    expect(archived).toContain(">Archived</dd>");
    expect(active).not.toContain("Archived");
  });
});

describe("RepositorySetupStatus", () => {
  it("does not render a Ready pill for healthy setup", () => {
    expect(statusMarkup("ready")).toBe("");
  });

  it("keeps non-healthy setup states visible and programmatically named", () => {
    expect(statusMarkup("not_set_up")).toContain('aria-label="Not set up"');
    expect(statusMarkup("not_set_up")).toContain('data-status="not_started"');
    expect(statusMarkup("pr_open")).toContain('aria-label="Setup PR open"');
    expect(statusMarkup("pr_open")).toContain('data-status="awaiting_review"');
    expect(statusMarkup("conflict")).toContain('aria-label="Conflict"');
    expect(statusMarkup("conflict")).toContain('data-status="needs_attention"');
    expect(statusMarkup("error")).toContain('aria-label="Error"');
    expect(statusMarkup("error")).toContain('data-status="blocked"');
  });
});

describe("repository setup cards", () => {
  it("omits Selected and Ready pills on a selected healthy repository", () => {
    const html = cardMarkup("ready");

    expect(html).toContain("acme/app");
    expect(html).not.toContain(">Selected</span>");
    expect(html).not.toContain(">Ready</span>");
    expect(html).not.toContain('aria-label="Selected"');
    expect(html).not.toContain('aria-label="Ready"');
    expect(html).not.toContain('data-status="approved"');
    expect(html).not.toContain('data-status="healthy"');
    expect(html).toContain(">Analyze repository</button>");
  });

  it("renders setup-required, open-PR, conflict, and error states", () => {
    const setupRequired = cardMarkup("not_set_up");
    const openPr = cardMarkup("pr_open");
    const conflict = cardMarkup("conflict");
    const error = cardMarkup("error");

    expect(setupRequired).toContain('aria-label="Not set up"');
    expect(setupRequired).toContain(">Install skills</button>");
    expect(openPr).toContain('aria-label="Setup PR open"');
    expect(openPr).toContain("View setup PR");
    expect(conflict).toContain('aria-label="Conflict"');
    expect(conflict).toContain("Existing skill files need review.");
    expect(error).toContain('aria-label="Error"');
    expect(error).toContain("GitHub read failed");

    for (const html of [setupRequired, openPr, conflict, error]) {
      expect(html).not.toContain(">Selected</span>");
      expect(html).not.toContain(">Ready</span>");
    }
  });
});
