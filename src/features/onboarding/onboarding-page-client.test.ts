import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { reduceOnboardingMutationData } from "@/features/onboarding/mutation-reducer";
import { applyAgentConfigDraftChange } from "@/lib/agent-config/drafts";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import { CURRENT_WALLIE_SKILL_VERSION } from "@/lib/repo-onboarding/contracts";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import {
  applySavedPipelineToData,
  applySavedRepositoryProfileToData,
  buildRepositoryProfileCompletionPatch,
  isAgentConfigDraftDirty,
  isRepositorySelectionCurrent,
  OnboardingPageClient,
  RepositoryProfileEditor,
  scrollOnboardingSetupToTop,
  setupHealthItems,
  updateSandboxCapabilityCheckInData,
} from "@/features/onboarding/onboarding-page-client";

const configuredPipeline = {
  id: "pipeline-1",
  isDefault: true,
  name: "Default",
  operatingRulesMd: "",
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

function workspaceSecret(
  key: string,
  overrides: Partial<WorkspaceOnboardingData["workspaceSecrets"][number]> = {},
) {
  return {
    createdAt: "2026-05-16T18:00:00.000Z",
    createdByMemberId: "member-1",
    id: `secret-${key.toLowerCase()}`,
    key,
    updatedAt: "2026-05-16T18:00:00.000Z",
    valuePreview: "...value",
    workspaceId: "workspace-1",
    ...overrides,
  } satisfies WorkspaceOnboardingData["workspaceSecrets"][number];
}

type OnboardingDataOverrides = Omit<
  Partial<WorkspaceOnboardingData>,
  "onboarding" | "setupHealth" | "workspace"
> & {
  onboarding?: Partial<WorkspaceOnboardingData["onboarding"]>;
  setupHealth?: Partial<WorkspaceOnboardingData["setupHealth"]>;
  workspace?: Partial<WorkspaceOnboardingData["workspace"]>;
};

function onboardingData(overrides: OnboardingDataOverrides = {}): WorkspaceOnboardingData {
  const pipeline = overrides.pipeline === undefined ? configuredPipeline : overrides.pipeline;
  const {
    onboarding: onboardingOverride,
    setupHealth: setupHealthOverride,
    workspace: workspaceOverride,
    ...topLevelOverrides
  } = overrides;

  return {
    agentConfig: {
      agent_model: "gpt-5.5",
      agent_provider: "codex",
    },
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
      selectedGithubRepositoryId: null,
      skippedSteps: [],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
      ...onboardingOverride,
    },
    pipeline,
    setupHealth: {
      agentConfig: {
        configured: true,
        configuredKeys: ["agent_model", "agent_provider"],
        status: "present",
        values: {
          agent_model: "gpt-5.5",
          agent_provider: "codex",
        },
      },
      codexConnection: {
        connected: false,
        credentialType: null,
        expiresAt: null,
        status: "missing",
        updatedAt: null,
      },
      claudeCodeConnection: {
        connected: false,
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
      vercelSandboxConnection: {
        connected: true,
        lastValidationError: null,
        projectId: "prj_123",
        projectName: "wallie-sandboxes",
        status: "connected",
        teamId: "team_123",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      selectedRepository: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      linearKey: { configured: false, status: "missing", updatedAt: null },
      linearRouting: { configured: false, status: "missing", updatedAt: null },
      workspaceSecrets: { configuredKeys: [] },
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
      ...setupHealthOverride,
    },
    vercelSandboxConnection: {
      lastValidatedAt: "2026-05-16T18:00:00.000Z",
      lastValidationError: null,
      projectId: "prj_123",
      projectName: "wallie-sandboxes",
      status: "connected",
      teamId: "team_123",
      tokenPreview: "vca_...123",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
    },
    workspace: { id: "workspace-1", name: "Northwind", slug: "northwind", ...workspaceOverride },
    workspaceMembers: [],
    workspaceSecrets: [],
    ...topLevelOverrides,
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

function desktopRailButton(html: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<button[^>]*>[^]*?<span class="block truncate">${escapedLabel}<\\/span>[^]*?<\\/button>`,
    ),
  )?.[0];
  if (!match) {
    throw new Error(`${label} rail button was not rendered.`);
  }
  return match;
}

function connectedInstallation() {
  return {
    appId: 123,
    id: "installation-1",
    installationId: 456,
    installationUrl: "https://github.com/settings/installations/456",
    permissions: {},
    suspended: false,
    targetName: "acme",
    targetType: "Organization",
    updatedAt: "2026-05-16T18:00:00.000Z",
  };
}

function onboardingWithSelectedRepository(
  setupStatus: WorkspaceGitHubRepository["onboarding"]["status"],
) {
  const repo = repository("repo-a", {
    onboarding: {
      conflictReport: [],
      githubRepositoryId: "repo-a",
      installedSkillHash: null,
      installedSkillVersion: null,
      lastError: null,
      setupBranchName: setupStatus === "pr_open" ? "wallie/setup-repo-a" : null,
      setupPrNumber: setupStatus === "pr_open" ? 12 : null,
      setupPrUrl: setupStatus === "pr_open" ? "https://github.com/acme/repo-a/pull/12" : null,
      status: setupStatus,
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
  });

  return onboardingData({
    github: {
      installation: connectedInstallation(),
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [repo, repository("repo-b")],
    },
    onboarding: {
      completedAt: null,
      completedSteps: [],
      createdAt: "2026-05-16T18:00:00.000Z",
      currentStep: "github",
      dismissedAt: null,
      id: "onboarding-1",
      selectedGithubRepositoryId: "repo-a",
      skippedSteps: [],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
    },
    setupHealth: {
      githubInstallation: {
        connected: true,
        installationId: 456,
        status: "present",
        suspended: false,
        targetName: "acme",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      selectedRepository: {
        configured: true,
        fullName: "acme/repo-a",
        repositoryId: "repo-a",
        status: "ready",
      },
      repositorySetup: {
        configured: setupStatus === "ready",
        repositoryId: "repo-a",
        status: setupStatus,
      },
    },
  });
}

describe("reduceOnboardingMutationData", () => {
  it("installs step progress immediately without replacing unrelated setup data", () => {
    const current = onboardingData();
    const next = reduceOnboardingMutationData(current, {
      action: "continue",
      kind: "onboarding-mutation",
      onboarding: {
        completedAt: null,
        completedSteps: ["github", "repository", "pipeline"],
        currentStep: "linear",
        dismissedAt: null,
        selectedGithubRepositoryId: null,
        skippedSteps: [],
        status: "in_progress",
      },
      setupHealth: {},
      step: "pipeline",
      updatedAt: "2026-05-16T18:01:00.000Z",
      validationErrors: [],
    });

    expect(next.onboarding).toMatchObject({
      completedSteps: ["github", "repository", "pipeline"],
      currentStep: "linear",
      updatedAt: "2026-05-16T18:01:00.000Z",
    });
    expect(next.pipeline).toBe(current.pipeline);
    expect(next.workspaceSecrets).toBe(current.workspaceSecrets);
    expect(next.setupHealth).toBe(current.setupHealth);
  });

  it("restores authoritative repository health for conflicts on any action", () => {
    const current = onboardingData();
    const next = reduceOnboardingMutationData(current, {
      action: "navigate",
      authoritative: {
        onboarding: {
          completedAt: null,
          completedSteps: ["github"],
          currentStep: "repository",
          dismissedAt: null,
          selectedGithubRepositoryId: "repo-a",
          skippedSteps: [],
          status: "in_progress",
        },
        setupHealth: {
          latestSandboxCapabilityCheck: {
            capabilities: {},
            checkedAt: "2026-05-16T18:01:00.000Z",
            errorText: null,
            githubRepositoryId: "repo-a",
            id: "check-repo-a",
            sandboxProvider: "vercel",
            sandboxVercelProjectId: "project-a",
            sandboxVercelTeamId: "team-a",
            status: "success",
          },
          selectedRepository: {
            configured: true,
            fullName: "acme/repo-a",
            repositoryId: "repo-a",
            status: "ready",
          },
        },
        updatedAt: "2026-05-16T18:02:00.000Z",
      },
      error: "Latest progress was restored; retry your action.",
      kind: "onboarding-conflict",
      retryable: true,
      step: "linear",
      validationErrors: [],
    });

    expect(next.onboarding.selectedGithubRepositoryId).toBe("repo-a");
    expect(next.onboarding.updatedAt).toBe("2026-05-16T18:02:00.000Z");
    expect(next.setupHealth.selectedRepository).toEqual({
      configured: true,
      fullName: "acme/repo-a",
      repositoryId: "repo-a",
      status: "ready",
    });
    expect(next.setupHealth.latestSandboxCapabilityCheck?.id).toBe("check-repo-a");
    expect(next.setupHealth.agentConfig).toBe(current.setupHealth.agentConfig);
  });
});

describe("OnboardingPageClient", () => {
  it("uses red for health errors and grey for initial health states", () => {
    const noCheckHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData(),
      }),
    );
    const errorHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          setupHealth: {
            latestSandboxCapabilityCheck: {
              capabilities: {},
              checkedAt: "2026-05-16T18:00:00.000Z",
              errorText: "sandbox failed",
              githubRepositoryId: "repo-a",
              id: "check-1",
              sandboxProvider: "vercel",
              sandboxVercelProjectId: "prj_123",
              sandboxVercelTeamId: "team_123",
              status: "error",
            },
          },
        }),
      }),
    );

    expect(noCheckHtml).toMatch(
      /class="ui-status whitespace-nowrap ui-status-neutral"><span class="ui-status-dot"><\/span>No check/,
    );
    expect(errorHtml).toMatch(
      /class="ui-status whitespace-nowrap ui-status-danger"><span class="ui-status-dot"><\/span>Error/,
    );
  });

  it("renders sandbox health check times as relative copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T18:05:00.000Z"));

    try {
      const html = renderToStaticMarkup(
        createElement(OnboardingPageClient, {
          initialData: onboardingData({
            setupHealth: {
              latestSandboxCapabilityCheck: {
                capabilities: {},
                checkedAt: "2026-05-16T18:00:00.000Z",
                errorText: null,
                githubRepositoryId: "repo-a",
                id: "check-1",
                sandboxProvider: "vercel",
                sandboxVercelProjectId: "prj_123",
                sandboxVercelTeamId: "team_123",
                status: "success",
              },
            },
          }),
        }),
      );

      expect(html).toContain("Checked 5 minutes ago");
      expect(html).not.toContain("2026-05-16T18:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

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

    const latestSandboxCapabilityCheck = {
      capabilities: {},
      checkedAt: "2026-05-16T18:30:00.000Z",
      errorText: null,
      githubRepositoryId: "repo-a",
      id: "check-repo-a",
      sandboxProvider: "vercel" as const,
      sandboxVercelProjectId: "project-a",
      sandboxVercelTeamId: "team-a",
      status: "success" as const,
    };
    const nextData = applySavedRepositoryProfileToData(
      currentData,
      savedProfile,
      latestSandboxCapabilityCheck,
    );

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
    expect(nextData.setupHealth.latestSandboxCapabilityCheck).toBe(latestSandboxCapabilityCheck);
  });

  it("installs saved pipeline stages before advancing to Linear", () => {
    const currentData = onboardingData();
    const savedPipeline = {
      ...configuredPipeline,
      stages: [
        ...configuredPipeline.stages,
        {
          approverMemberIds: [],
          description: "Build",
          id: "stage-build",
          name: "Build",
          pipelineId: configuredPipeline.id,
          position: 2,
          promptTemplateMd: "Build prompt",
          slug: "build",
        },
      ],
    };

    const nextData = applySavedPipelineToData(currentData, savedPipeline);

    expect(nextData.pipeline).toBe(savedPipeline);
    expect(nextData.pipeline?.stages.map((stage) => stage.slug)).toEqual(["product", "build"]);
    expect(nextData.setupHealth.defaultPipeline).toEqual({
      configured: true,
      pipelineId: "pipeline-1",
      stageCount: 2,
      status: "ready",
    });
  });

  it("only applies repository async results for the latest selected repository", () => {
    expect(isRepositorySelectionCurrent("repo-b", "repo-a")).toBe(false);
    expect(isRepositorySelectionCurrent("repo-a", "repo-a")).toBe(true);
  });

  it("builds repository completion patches from the current step only", () => {
    const baseOnboarding = onboardingData().onboarding;
    const repositoryStep = onboardingData({
      onboarding: { ...baseOnboarding, currentStep: "repository" },
    }).onboarding;
    const linearStep = onboardingData({
      onboarding: { ...baseOnboarding, currentStep: "linear" },
    }).onboarding;

    expect(buildRepositoryProfileCompletionPatch(repositoryStep)).toEqual({
      completedSteps: ["github", "repository"],
      skippedSteps: [],
      status: "in_progress",
    });
    expect(buildRepositoryProfileCompletionPatch(linearStep)).toBeNull();
  });

  it("allows the GitHub step to continue once connected repositories are synced", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingWithSelectedRepository("not_set_up"),
      }),
    );

    expect(html).not.toContain('href="https://github.com/acme/repo-a"');
    expect(html).not.toContain("Install skills");
    expect(html).not.toContain("Mark skills as installed");
    expect(primaryFooterButton(html)).not.toContain("disabled");
  });

  it("blocks the GitHub step when only archived repositories are synced", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [repository("archived-repo", { isArchived: true })],
          },
          onboarding: {
            completedAt: null,
            completedSteps: [],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "github",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: null,
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            githubInstallation: {
              connected: true,
              installationId: 456,
              status: "present",
              suspended: false,
              targetName: "acme",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
          },
        }),
      }),
    );

    expect(primaryFooterButton(html)).toContain("disabled");
  });

  it("blocks the repository step until setup is open or ready", () => {
    const primary = profile("repo-a");
    const blocked = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: primary,
            repositories: [repository("repo-a", { profile: primary })],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: "repo-a",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: false,
              repositoryId: "repo-a",
              status: "not_set_up",
            },
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );
    const readyToAdvance = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: primary,
            repositories: [
              repository("repo-a", {
                onboarding: {
                  conflictReport: [],
                  githubRepositoryId: "repo-a",
                  installedSkillHash: null,
                  installedSkillVersion: null,
                  lastError: null,
                  setupBranchName: "wallie/setup-repo-a",
                  setupPrNumber: 12,
                  setupPrUrl: "https://github.com/acme/repo-a/pull/12",
                  status: "pr_open",
                  updatedAt: "2026-05-16T18:00:00.000Z",
                },
                profile: primary,
              }),
            ],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: "repo-a",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: false,
              repositoryId: "repo-a",
              status: "pr_open",
            },
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );

    expect(blocked.match(/>Install skills<\/button>/g) ?? []).toHaveLength(1);
    expect(blocked).toContain("Mark skills as installed");
    expect(primaryFooterButton(blocked)).toContain("disabled");
    expect(primaryFooterButton(readyToAdvance)).not.toContain("disabled");
  });

  it("renders future and read-only sidebar steps as section navigation targets", () => {
    const managerHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: [],
            currentStep: "github",
          },
        }),
      }),
    );
    const readOnlyHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          canManage: false,
          currentMember: { id: "member-2", role: "member" },
          onboarding: {
            completedSteps: [],
            currentStep: "github",
          },
        }),
      }),
    );

    const futureButton = desktopRailButton(managerHtml, "Verify setup");
    const readOnlyButton = desktopRailButton(readOnlyHtml, "Analyze repositories");
    expect(futureButton).not.toContain("disabled");
    expect(futureButton).not.toContain("cursor-not-allowed");
    expect(readOnlyButton).not.toContain("disabled");
    expect(readOnlyButton).not.toContain("cursor-not-allowed");
  });

  it("renders Linear and agent provider setup with Connect labels", () => {
    const linearHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline"],
            currentStep: "linear",
          },
        }),
      }),
    );
    const runtimeHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline", "linear"],
            currentStep: "runtime",
          },
        }),
      }),
    );

    expect(desktopRailButton(linearHtml, "Connect Linear")).toContain('aria-current="step"');
    expect(linearHtml).toContain(">Connect Linear</h2>");
    expect(desktopRailButton(runtimeHtml, "Connect Agent")).toContain('aria-current="step"');
    expect(runtimeHtml).toContain(">Connect Agent</h2>");
    expect(runtimeHtml).toContain('<span class="truncate">Agent</span>');
    expect(runtimeHtml).not.toContain('<span class="truncate">Runtime</span>');
  });

  it("shows setup actions in Analyze repositories for every synced repository", () => {
    const primary = profile("repo-a");
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: primary,
            repositories: [repository("repo-a", { profile: primary }), repository("repo-b")],
          },
          onboarding: {
            completedAt: null,
            completedSteps: [],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: null,
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: false,
              repositoryId: "repo-a",
              status: "not_set_up",
            },
          },
        }),
      }),
    );

    expect(html.match(/>Install skills<\/button>/g) ?? []).toHaveLength(2);
    expect(html).toContain("Mark skills as installed");
  });

  it("renders repository setup controls in the analysis step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [repository("repo-a")],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: "repo-a",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: false,
              repositoryId: "repo-a",
              status: "pr_open",
            },
          },
        }),
      }),
    );

    expect(html).toContain("Analyze repositories");
    expect(html).toContain("Install skills");
    expect(html).toContain("Mark skills as installed");
    expect(html).not.toContain(">Analyze repository</button>");
    expect(primaryFooterButton(html)).toContain("disabled");
  });

  it("renders repository analysis in the setup action row after skills are ready", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [
              repository("repo-a", {
                onboarding: {
                  conflictReport: [],
                  githubRepositoryId: "repo-a",
                  installedSkillHash: "hash-1",
                  installedSkillVersion: CURRENT_WALLIE_SKILL_VERSION,
                  lastError: null,
                  setupBranchName: null,
                  setupPrNumber: null,
                  setupPrUrl: null,
                  status: "ready",
                  updatedAt: "2026-05-16T18:00:00.000Z",
                },
              }),
            ],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: "repo-a",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: true,
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );

    expect(html).toContain(">Analyze repository</button>");
    expect(html).toContain(
      'border-t border-border pt-3 sm:justify-end"><button class="ui-button-primary"',
    );
    expect(html).not.toContain("Install skills");
    expect(html).not.toContain("Mark skills as installed");
  });

  it("offers skill updates for ready repositories with stale installed skills", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [
              repository("repo-a", {
                onboarding: {
                  conflictReport: [],
                  githubRepositoryId: "repo-a",
                  installedSkillHash: "hash-1",
                  installedSkillVersion: 1,
                  lastError: null,
                  setupBranchName: null,
                  setupPrNumber: null,
                  setupPrUrl: null,
                  status: "ready",
                  updatedAt: "2026-05-16T18:00:00.000Z",
                },
              }),
            ],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: "repo-a",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: true,
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );

    expect(html).toContain("Update skills");
    expect(html).toContain(">Analyze repository</button>");
    expect(html).not.toContain("Mark skills as installed");
  });

  it("allows repository analysis progression when legacy state has an is_primary profile but no selected repo id", () => {
    const primary = profile("repo-a");
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: connectedInstallation(),
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: primary,
            repositories: [repository("repo-a", { profile: primary })],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "repository",
            dismissedAt: null,
            id: "onboarding-1",
            selectedGithubRepositoryId: null,
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            selectedRepository: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: true,
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );

    expect(html).toContain("Repository profile");
    expect(html).not.toContain(">Primary<");
    expect(primaryFooterButton(html)).not.toContain("disabled");
  });

  it("keeps repository analyze and save loading labels separate", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryProfileEditor, {
        canManage: true,
        isAnalyzing: false,
        isSaving: true,
        onChange: () => undefined,
        onInfer: () => undefined,
        onSave: () => undefined,
        profile: profile("repo-a"),
      }),
    );

    expect(html).toContain(">Re-analyze</button>");
    expect(html).toContain(">Saving…</button>");
    expect(html).not.toContain(">Analyzing…</button>");
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
    expect(html).toContain("Save pipeline");
    expect(html).not.toContain("Use current pipeline");
    expect(button).toContain("disabled");
    expect(button).toContain(">Save pipeline to continue</button>");
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
    expect(html).not.toContain("Test connection");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("lin_api_plaintext");
  });

  it("renders provider access and repository env suggestions without a runtime credentials card", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: null,
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: profile("repo-a", {
              envKeySuggestions: ["NEXT_PUBLIC_APP_URL", "VERCEL_GITHUB_APP_PRIVATE_KEY_BASE64"],
            }),
            repositories: [],
          },
          onboarding: {
            completedSteps: ["github", "repository", "pipeline"],
            currentStep: "runtime",
          },
        }),
      }),
    );

    expect(html).toContain("Provider access");
    expect(html).toContain("Sessions run with the Codex credential saved by the session creator");
    expect(html).toContain("Checking connection");
    expect(html.indexOf("Concurrency")).toBeLessThan(html.indexOf("Provider access"));
    expect(html.indexOf("Stall timeout")).toBeLessThan(html.indexOf("Provider access"));
    expect(html.indexOf("Max retries")).toBeLessThan(html.indexOf("Provider access"));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("Runtime credentials");
    expect(html).not.toContain("No encrypted workspace secret is required");
    expect(html).toContain("Repository environment variables");
    expect(html).toContain("NEXT_PUBLIC_APP_URL");
    expect(html).toContain("VERCEL_GITHUB_APP_PRIVATE_KEY_BASE64");
    expect(html).toContain('<input aria-label="Value for NEXT_PUBLIC_APP_URL"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('<textarea aria-label="Value for NEXT_PUBLIC_APP_URL"');
    expect(html).not.toContain("ui-textarea min-h-20");
    expect(html.match(/>Save config<\/button>/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('aria-label="Save NEXT_PUBLIC_APP_URL"');
    expect(html).toContain("Add variable");
    expect(html).not.toContain('aria-label="New variable name"');
    expect(html).not.toContain("border-t border-border bg-control-hover px-4 py-4");
    expect(html).toContain("Not set");
    expect(html).toContain('ui-status-neutral"><span class="ui-status-dot"></span>Not set');
    expect(html).not.toContain("Needs value");
    expect(html).not.toContain("Public/deployment");
    expect(html).not.toContain("Server env");
    expect(html).not.toContain("Workspace secrets");
    expect(html).not.toContain("Runtime checks the current user");
    expect(html).toContain('<select aria-hidden="true"');
    expect(html).not.toContain('value="NEXT_PUBLIC_APP_URL"');
    expect(html).not.toContain("truncate font-mono");
  });

  it("connects the Vercel Sandbox inline from the Connect Agent step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline", "linear"],
            currentStep: "runtime",
          },
        }),
      }),
    );

    expect(html).toContain('id="onboarding-vercel"');
    expect(html).toContain("Save Vercel connection");
    expect(html).toContain('placeholder="vca_…"');
    expect(html).toContain('placeholder="team_…"');
    expect(html).toContain('placeholder="prj_…"');
    // Default data has a connection, so an inline Disconnect control is offered.
    expect(html).toContain("Disconnect");
    // The Vercel connection is made in the wizard, not by detouring into Settings.
    expect(html).not.toContain('href="/w/northwind/settings#vercel"');
  });

  it("blocks Connect Agent completion until the Vercel Sandbox is connected", () => {
    const connectedCodex = {
      connected: true,
      credentialType: "platform_api_key" as const,
      expiresAt: null,
      status: "connected" as const,
      updatedAt: "2026-05-16T18:00:00.000Z",
    };

    const blockedHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline", "linear"],
            currentStep: "runtime",
          },
          setupHealth: {
            codexConnection: connectedCodex,
            vercelSandboxConnection: {
              connected: false,
              lastValidationError: null,
              projectId: null,
              projectName: null,
              status: "missing",
              teamId: null,
              updatedAt: null,
            },
          },
          vercelSandboxConnection: null,
        }),
      }),
    );
    expect(primaryFooterButton(blockedHtml)).toContain("disabled");
    expect(blockedHtml).toContain("Connect a Vercel project before running Wallie sessions.");

    const readyHtml = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline", "linear"],
            currentStep: "runtime",
          },
          setupHealth: {
            codexConnection: connectedCodex,
          },
        }),
      }),
    );
    expect(primaryFooterButton(readyHtml)).not.toContain("disabled");
  });

  it("normalizes repository env keys before rendering saved state", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: null,
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: profile("repo-a", {
              envKeySuggestions: ["api_key", "API_KEY"],
            }),
            repositories: [],
          },
          onboarding: {
            completedSteps: ["github", "repository", "pipeline"],
            currentStep: "runtime",
          },
          workspaceSecrets: [workspaceSecret("API_KEY")],
        }),
      }),
    );

    expect(html.match(/<code[^>]*>API_KEY<\/code>/g) ?? []).toHaveLength(1);
    expect(html).toContain("Stored");
    expect(html).not.toContain("Stored ...value");
    expect(html).not.toContain(">api_key<");
    expect(html).not.toContain("Not set");
  });

  it("keeps provider-like env keys as repository notes for the Claude Code runner", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          agentConfig: {
            agent_model: "claude-opus-4-7[1m]",
            agent_provider: "claude-code",
          },
          github: {
            installation: null,
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: profile("repo-a", {
              envKeySuggestions: ["ANTHROPIC_API_KEY", "NEXT_PUBLIC_APP_URL"],
            }),
            repositories: [],
          },
          onboarding: {
            completedSteps: ["github", "repository", "pipeline"],
            currentStep: "runtime",
          },
          setupHealth: {
            agentConfig: {
              configured: true,
              configuredKeys: ["agent_model", "agent_provider"],
              status: "present",
              values: {
                agent_model: "claude-opus-4-7[1m]",
                agent_provider: "claude-code",
              },
            },
          },
        }),
      }),
    );

    expect(html).toContain("ANTHROPIC_API_KEY");
    expect(html).toContain("NEXT_PUBLIC_APP_URL");
    expect(html).toContain("Provider access");
    expect(html).toContain("Claude Code");
    expect(html).not.toContain(">claude-code<");
    expect(html).toContain("Sessions run with the Anthropic API key saved by the session creator");
    expect(html).not.toContain("Runtime credentials");
    expect(html).not.toContain("No encrypted workspace secret is required");
    expect(html).not.toContain("Public/deployment");
    expect(html).not.toContain("Server env");
    expect(html).toContain("Anthropic API key");
    expect(html).not.toContain('value="ANTHROPIC_API_KEY"');
  });

  it("does not render a section-level runtime readiness badge", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedSteps: ["github", "repository", "pipeline", "linear"],
            currentStep: "runtime",
          },
        }),
      }),
    );

    expect(html).toContain("Runtime readiness");
    expect(html).not.toMatch(
      /Runtime readiness<\/h3><p[^>]*>Provider-specific requirements must pass before this step can complete\.<\/p><\/div><span class="ui-status/,
    );
  });

  it("renders Verify blockers with links to owning steps and disables completion", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
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
    expect(html).toContain("Readiness checklist");
    expect(html).toContain('data-step-link="linear"');
    expect(html).toContain('data-step-link="runtime"');
    expect(html).toContain("Save a repository profile before running a sandbox capability check.");
    expect(button).toContain("disabled");
    expect(button).toContain(">Complete setup</button>");
  });

  it("routes the Vercel Sandbox blocker back into the Connect Agent step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            vercelSandboxConnection: {
              connected: false,
              lastValidationError: null,
              projectId: null,
              projectName: null,
              status: "missing",
              teamId: null,
              updatedAt: null,
            },
          },
        }),
      }),
    );

    const vercelRow = html.slice(html.indexOf("Vercel Sandbox connected"));
    expect(html).toContain("Vercel Sandbox connected");
    // The blocker stays inside the wizard (Connect Agent / runtime step), not Settings.
    expect(html).not.toContain('href="/w/northwind/settings#vercel"');
    expect(html).not.toContain("Open Vercel");
    expect(vercelRow).toContain('data-step-link="runtime"');
    expect(vercelRow.slice(0, vercelRow.indexOf("</button>") + 9)).toContain("Open Agent");
  });

  it("enables the Verify completion CTA when every blocker passes", () => {
    const repo = repository("repo-a", {
      onboarding: {
        conflictReport: [],
        githubRepositoryId: "repo-a",
        installedSkillHash: null,
        installedSkillVersion: null,
        lastError: null,
        setupBranchName: null,
        setupPrNumber: null,
        setupPrUrl: null,
        status: "ready",
        updatedAt: "2026-05-16T18:00:00.000Z",
      },
      profile: profile("repo-a"),
    });
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          github: {
            installation: null,
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: profile("repo-a"),
            repositories: [repo],
          },
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            codexConnection: {
              connected: true,
              credentialType: "codex_access_token",
              expiresAt: "2026-05-16T20:00:00.000Z",
              status: "connected",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            repositorySetup: {
              configured: true,
              repositoryId: "repo-a",
              status: "ready",
            },
            latestSandboxCapabilityCheck: {
              capabilities: {},
              checkedAt: "2026-05-16T18:00:00.000Z",
              errorText: null,
              githubRepositoryId: "repo-a",
              id: "check-1",
              sandboxProvider: "vercel",
              sandboxVercelProjectId: "prj_123",
              sandboxVercelTeamId: "team_123",
              status: "success",
            },
          },
        }),
      }),
    );

    const button = primaryFooterButton(html);
    expect(html).toContain("Latest selected-repository sandbox capability check succeeded.");
    expect(button).not.toContain("disabled");
    expect(button).toContain(">Complete setup</button>");
  });

  it("renders sandbox polling and retry states", () => {
    const running = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            latestSandboxCapabilityCheck: {
              capabilities: {},
              checkedAt: "2026-05-16T18:00:00.000Z",
              errorText: null,
              githubRepositoryId: "repo-a",
              id: "check-1",
              sandboxProvider: null,
              sandboxVercelProjectId: null,
              sandboxVercelTeamId: null,
              status: "running",
            },
          },
        }),
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
            latestSandboxCapabilityCheck: {
              capabilities: {},
              checkedAt: "2026-05-16T18:00:00.000Z",
              errorText: "sandbox failed",
              githubRepositoryId: "repo-a",
              id: "check-1",
              sandboxProvider: "vercel",
              sandboxVercelProjectId: "prj_123",
              sandboxVercelTeamId: "team_123",
              status: "error",
            },
          },
        }),
      }),
    );

    expect(running).toContain("Checking…");
    expect(running).toContain(">Running</span>");
    expect(running).toContain("disabled");
    expect(failed).toContain(">Failed</span>");
    expect(failed).toContain("Retry capability check");
    expect(failed).toContain("sandbox failed");
  });

  it("disables sandbox capability checks for non-managers", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingPageClient, {
        initialData: onboardingData({
          canManage: false,
          currentMember: { id: "member-2", role: "member" },
          onboarding: {
            completedAt: null,
            completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
            createdAt: "2026-05-16T18:00:00.000Z",
            currentStep: "verify",
            dismissedAt: null,
            id: "onboarding-1",
            skippedSteps: [],
            status: "in_progress",
            updatedAt: "2026-05-16T18:00:00.000Z",
            workspaceId: "workspace-1",
          },
          setupHealth: {
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/repo-a",
              repositoryId: "repo-a",
              status: "ready",
            },
          },
        }),
      }),
    );

    const match = html.match(/<button[^>]*>Run capability check<\/button>/)?.[0];
    expect(match).toContain("disabled");
  });

  it("normalizes agent config drafts before dirty comparison", () => {
    expect(isAgentConfigDraftDirty("concurrency_limit", "number", "01", "1")).toBe(false);
    // Stall timeout drafts are entered in minutes; "15.0" normalizes to the saved "15".
    expect(isAgentConfigDraftDirty("stall_timeout_ms", "number", "15.0", "15")).toBe(false);
    expect(isAgentConfigDraftDirty("stall_timeout_ms", "number", "10", "15")).toBe(true);
    expect(isAgentConfigDraftDirty("max_retries", "number", "2", "3")).toBe(true);
  });

  it("pairs Onboarding provider changes with the provider's recommended model", () => {
    const currentDrafts = {
      agent_model: "gpt-5.5",
      agent_provider: "codex",
      concurrency_limit: "1",
      max_retries: "3",
      stall_timeout_ms: "300000",
    };

    expect(
      applyAgentConfigDraftChange(currentDrafts, "agent_provider", "claude-code"),
    ).toMatchObject({
      agent_model: "claude-opus-4-7[1m]",
      agent_provider: "claude-code",
    });
    expect(applyAgentConfigDraftChange(currentDrafts, "agent_provider", "codex")).toMatchObject({
      agent_model: "gpt-5.5",
      agent_provider: "codex",
    });
  });

  it("merges sandbox capability results into the latest onboarding data", () => {
    const currentData = onboardingData({
      onboarding: {
        completedSteps: ["github", "repository", "pipeline"],
        currentStep: "runtime",
      },
    });
    const nextData = updateSandboxCapabilityCheckInData(currentData, {
      capabilities: {},
      checkedAt: "2026-05-16T19:00:00.000Z",
      errorText: null,
      githubRepositoryId: "repo-a",
      id: "check-2",
      sandboxProvider: "vercel",
      sandboxVercelProjectId: "prj_123",
      sandboxVercelTeamId: "team_123",
      status: "success",
    });

    expect(nextData.onboarding.currentStep).toBe("runtime");
    expect(nextData.onboarding.completedSteps).toEqual(["github", "repository", "pipeline"]);
    expect(nextData.setupHealth.latestSandboxCapabilityCheck?.id).toBe("check-2");
  });

  it("scrolls onboarding setup transitions back to the top", () => {
    const scrollTo = vi.fn();

    scrollOnboardingSetupToTop({ scrollTo });

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 0 });
  });
});

describe("setupHealthItems Linear routing badge", () => {
  const routingItem = (setupHealth: Partial<WorkspaceOnboardingData["setupHealth"]>) =>
    setupHealthItems(onboardingData({ setupHealth }).setupHealth).find(
      (item) => item.label === "Linear routing",
    );

  it("does not show a green 'Saved' badge for seeded default routes without a Linear key", () => {
    // Fresh workspace: routing row is seeded (configured) but no Linear key yet.
    expect(
      routingItem({
        linearKey: { configured: false, status: "missing", updatedAt: null },
        linearRouting: {
          configured: true,
          status: "present",
          updatedAt: "2026-05-16T18:00:00.000Z",
        },
      }),
    ).toMatchObject({
      value: "Defaults",
      tone: "neutral",
      detail: "Default routes — add a Linear key",
    });
  });

  it("shows green 'Saved' only once the Linear key is present", () => {
    expect(
      routingItem({
        linearKey: { configured: true, status: "present", updatedAt: "2026-05-16T18:00:00.000Z" },
        linearRouting: {
          configured: true,
          status: "present",
          updatedAt: "2026-05-16T18:00:00.000Z",
        },
      }),
    ).toMatchObject({ value: "Saved", tone: "success" });
  });

  it("shows 'Missing' when no routing row exists", () => {
    expect(
      routingItem({
        linearKey: { configured: false, status: "missing", updatedAt: null },
        linearRouting: { configured: false, status: "missing", updatedAt: null },
      }),
    ).toMatchObject({ value: "Missing", tone: "warning" });
  });
});
