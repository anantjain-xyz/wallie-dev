// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/features/onboarding/steps/active-step", () => ({
  ActiveOnboardingStep: () => <div data-testid="active-step">Active step</div>,
}));

const pipeline = {
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

function onboardingData(
  overrides: Partial<WorkspaceOnboardingData["onboarding"]> = {},
): WorkspaceOnboardingData {
  return {
    agentConfig: { agent_model: "gpt-5.5", agent_provider: "codex" },
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
      completedSteps: ["github", "repository", "pipeline"],
      createdAt: "2026-05-16T18:00:00.000Z",
      currentStep: "runtime",
      dismissedAt: null,
      id: "onboarding-1",
      selectedGithubRepositoryId: null,
      skippedSteps: ["linear"],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
      ...overrides,
    },
    pipeline,
    setupHealth: {
      agentConfig: {
        configured: true,
        configuredKeys: ["agent_model", "agent_provider"],
        status: "present",
        values: { agent_model: "gpt-5.5", agent_provider: "codex" },
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: "2026-05-16T18:00:01.000Z",
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "missing",
        updatedAt: null,
      },
      claudeCodeConnection: {
        checkedAt: "2026-05-16T18:00:01.000Z",
        connected: false,
        status: "missing",
        updatedAt: null,
      },
      defaultPipeline: {
        configured: true,
        pipelineId: pipeline.id,
        stageCount: 1,
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
  };
}

describe("onboarding shell accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("has no detectable axe violations for skipped/current orientation shell", async () => {
    const { container } = render(
      <OverlayProvider>
        <OnboardingPageClient initialData={onboardingData()} />
      </OverlayProvider>,
    );

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
