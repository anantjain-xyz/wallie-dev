import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import {
  applySavedRepositoryProfileToData,
  buildRepositoryProfileAutoContinuePatch,
  isRepositorySelectionCurrent,
  OnboardingPageClient,
} from "@/features/onboarding/onboarding-page-client";

const configuredPipeline = {
  id: "pipeline-1",
  isDefault: true,
  name: "Default",
  stages: [
    {
      approverMemberIds: [],
      description: "Product",
      id: "stage-product",
      name: "Product",
      pipelineId: "pipeline-1",
      position: 1,
      promptTemplateMd: "Product prompt",
      slug: "product",
    },
  ],
};

function repository(id: string, overrides: Partial<WorkspaceGitHubRepository> = {}) {
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
    },
    profile: null,
    repoId: 100,
    ...overrides,
  } satisfies WorkspaceGitHubRepository;
}

function profile(githubRepositoryId: string, overrides: Partial<RepositoryProfileState> = {}) {
  return {
    buildCommand: "pnpm build",
    createdAt: "2026-05-16T18:00:00.000Z",
    envKeySuggestions: [],
    frameworkHints: ["next"],
    githubRepositoryId,
    id: `profile-${githubRepositoryId}`,
    inferenceConfidence: "manual",
    inferenceSources: [{ path: "package.json", reason: "Read package metadata" }],
    installCommand: "pnpm install",
    isPrimary: true,
    languageHints: ["typescript"],
    packageManager: "pnpm",
    setupNotes: "",
    testCommand: "pnpm test",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  } satisfies RepositoryProfileState;
}

function onboardingData(overrides: Partial<WorkspaceOnboardingData> = {}): WorkspaceOnboardingData {
  const pipeline = overrides.pipeline === undefined ? configuredPipeline : overrides.pipeline;

  return {
    canManage: true,
    currentMember: { id: "member-1", role: "owner" },
    github: {
      installation: null,
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [],
    },
    linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
    linearSecret: null,
    onboarding: {
      completedAt: null,
      completedSteps: ["github", "repository"],
      createdAt: "2026-05-16T18:00:00.000Z",
      currentStep: "pipeline",
      dismissedAt: null,
      id: "onboarding-1",
      skippedSteps: [],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
      ...overrides.onboarding,
    },
    pipeline,
    setupHealth: {
      agentConfig: { configured: false, configuredKeys: [], status: "missing" },
      codexConnection: {
        connected: false,
        expiresAt: null,
        status: "missing",
        updatedAt: null,
      },
      defaultPipeline: pipeline
        ? {
            configured: true,
            pipelineId: pipeline.id,
            stageCount: pipeline.stages.length,
            status: "ready",
          }
        : {
            configured: false,
            pipelineId: null,
            stageCount: 0,
            status: "missing",
          },
      githubInstallation: {
        connected: true,
        installationId: 123,
        status: "present",
        suspended: false,
        targetName: "wallie",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      latestSandboxCapabilityCheck: null,
      linearKey: { configured: false, status: "missing", updatedAt: null },
      linearRouting: { configured: false, status: "missing", updatedAt: null },
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
      ...overrides.setupHealth,
    },
    workspace: { id: "workspace-1", name: "Northwind", slug: "northwind", ...overrides.workspace },
    workspaceMembers: [],
    ...overrides,
  };
}

function primaryFooterButton(html: string) {
  const matches = [...html.matchAll(/<button[^>]*class="ui-button-primary"[^>]*>.*?<\/button>/g)];
  const footerButton = matches.at(-1)?.[0];
  if (!footerButton) {
    throw new Error("Primary footer button was not rendered.");
  }
  return footerButton;
}

describe("OnboardingPageClient", () => {
  it("merges a saved repository profile into the latest GitHub state", () => {
    const previousPrimary = profile("repo-b");
    const currentData = onboardingData({
      github: {
        installation: null,
        missingAppKeys: [],
        missingWebhookKeys: [],
        primaryProfile: previousPrimary,
        repositories: [
          repository("repo-a", { name: "fresh-repo-a" }),
          repository("repo-b", { profile: previousPrimary }),
        ],
      },
    });
    const savedProfile = profile("repo-a");

    const nextData = applySavedRepositoryProfileToData(currentData, savedProfile);

    expect(nextData.github.primaryProfile).toBe(savedProfile);
    expect(nextData.github.repositories[0]).toMatchObject({
      name: "fresh-repo-a",
      profile: savedProfile,
    });
    expect(nextData.github.repositories[1]?.profile).toMatchObject({ isPrimary: false });
    expect(nextData.setupHealth.primaryRepositoryProfile).toMatchObject({
      configured: true,
      repositoryId: "repo-a",
    });
  });

  it("only applies repository async results for the latest selected repository", () => {
    expect(isRepositorySelectionCurrent("repo-b", "repo-a")).toBe(false);
    expect(isRepositorySelectionCurrent("repo-a", "repo-a")).toBe(true);
  });

  it("builds repository auto-continue patches from the current step only", () => {
    const baseOnboarding = onboardingData().onboarding;
    const repositoryStep = onboardingData({
      onboarding: { ...baseOnboarding, currentStep: "repository" },
    }).onboarding;
    const linearStep = onboardingData({
      onboarding: { ...baseOnboarding, currentStep: "linear" },
    }).onboarding;

    expect(buildRepositoryProfileAutoContinuePatch(repositoryStep)).toMatchObject({
      currentStep: "pipeline",
    });
    expect(buildRepositoryProfileAutoContinuePatch(linearStep)).toBeNull();
  });

  it("allows fallback progression when the pipeline editor cannot render", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({ pipeline: null }),
      }),
    );

    const button = primaryFooterButton(html);
    expect(html).toContain("Workspace has no default pipeline.");
    expect(button).toContain(">Continue</button>");
    expect(button).not.toContain("disabled");
  });

  it("keeps footer progression disabled while inline pipeline completion is available", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData(),
      }),
    );

    const button = primaryFooterButton(html);
    expect(button).toContain("disabled");
    expect(button).toContain(">Complete in step</button>");
  });

  it("allows fallback progression when Linear routing cannot load pipeline stages", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "linear",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          pipeline: null,
        }),
      }),
    );

    const button = primaryFooterButton(html);
    expect(button).toContain(">Continue</button>");
    expect(button).not.toContain("disabled");
  });

  it("allows continuing when returning to an already-completed inline step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "pipeline",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
        }),
      }),
    );

    const button = primaryFooterButton(html);
    expect(button).toContain(">Continue</button>");
    expect(button).not.toContain("disabled");
  });

  it("lets onboarding replace an existing Linear key inline", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          linearSecret: {
            createdAt: "2026-05-16T18:00:00.000Z",
            createdByMemberId: "member-1",
            id: "secret-1",
            key: "LINEAR_API_KEY",
            updatedAt: "2026-05-16T18:00:00.000Z",
            valuePreview: "••••1234",
            workspaceId: "workspace-1",
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "linear",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
        }),
      }),
    );

    expect(html).toContain("Linear API key configured");
    expect(html).toContain("Replace Linear API key");
    expect(html).toContain('type="password"');
    expect(html).toContain("Save key");
    expect(html).toContain("Test connection");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("lin_api_plaintext");
  });
});
