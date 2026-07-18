import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const mocked = vi.hoisted(() => ({
  OnboardingPageClient: vi.fn(() => null),
  loadAuthenticatedWorkspaceContext: vi.fn(),
  loadWorkspaceOnboardingDataForContext: vi.fn(),
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

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

vi.mock("@/features/onboarding/data", () => ({
  loadWorkspaceOnboardingDataForContext: mocked.loadWorkspaceOnboardingDataForContext,
}));

vi.mock("@/features/onboarding/onboarding-page-client", () => ({
  OnboardingPageClient: mocked.OnboardingPageClient,
}));

import WorkspaceOnboardingPage from "./page";

const onboardingData = {
  agentConfig: {},
  canManage: false,
  currentMember: { id: "member-1", role: "member" },
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
    completedSteps: [],
    createdAt: "2026-05-16T18:00:00.000Z",
    currentStep: "runtime",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: null,
    skippedSteps: ["linear"],
    status: "dismissed",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
  },
  pipeline: {
    id: "pipeline-1",
    isDefault: true,
    name: "Default",
    operatingRulesMd: "",
    stages: [
      {
        approverMemberIds: [],
        description: "Product",
        id: "stage-1",
        name: "Product",
        pipelineId: "pipeline-1",
        position: 1,
        promptTemplateMd: "Product prompt",
        slug: "product",
      },
    ],
  },
  setupHealth: {
    agentConfig: { configured: false, configuredKeys: [], status: "missing", values: {} },
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
    defaultPipeline: {
      configured: true,
      pipelineId: "pipeline-1",
      stageCount: 6,
      status: "ready",
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
  workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
  workspaceMembers: [],
  workspaceSecrets: [],
} satisfies WorkspaceOnboardingData;

describe("workspace onboarding page", () => {
  it("renders member-accessible onboarding data without the app shell", async () => {
    const authenticatedContext = {
      workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
    };
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue(authenticatedContext);
    mocked.loadWorkspaceOnboardingDataForContext.mockResolvedValue({
      data: onboardingData,
      ok: true,
    });

    const element = (await WorkspaceOnboardingPage({
      params: Promise.resolve({ workspaceSlug: "northwind" }),
    })) as ReactElement<{ initialData: WorkspaceOnboardingData }>;

    expect(element.type).toBe(mocked.OnboardingPageClient);
    expect(element.props.initialData).toBe(onboardingData);
    expect(mocked.loadWorkspaceOnboardingDataForContext).toHaveBeenCalledWith(authenticatedContext);
  });

  it("redirects when onboarding data reports an unauthenticated request", async () => {
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      workspace: { id: "workspace-2", name: "Southwind", slug: "southwind" },
    });
    mocked.loadWorkspaceOnboardingDataForContext.mockResolvedValue({
      error: "Sign in before managing workspace settings.",
      ok: false,
      status: 401,
    });

    await expect(
      WorkspaceOnboardingPage({
        params: Promise.resolve({ workspaceSlug: "southwind" }),
      }),
    ).rejects.toThrow("redirect:/login?next=%2Fw%2Fsouthwind%2Fonboarding");
  });

  it("returns not found when onboarding data cannot load for the workspace", async () => {
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      workspace: { id: "workspace-3", name: "Eastwind", slug: "eastwind" },
    });
    mocked.loadWorkspaceOnboardingDataForContext.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    await expect(
      WorkspaceOnboardingPage({
        params: Promise.resolve({ workspaceSlug: "eastwind" }),
      }),
    ).rejects.toThrow("not-found");
  });
});
