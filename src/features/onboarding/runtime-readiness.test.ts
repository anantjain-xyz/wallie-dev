import { describe, expect, it } from "vitest";

import {
  buildRuntimeReadiness,
  buildVerifyChecklist,
  verifyBlockersFromChecklist,
} from "@/features/onboarding/runtime-readiness";
import type { OnboardingSetupHealth, WorkspaceOnboardingState } from "@/lib/onboarding/contracts";

const repositoryId = "11111111-1111-4111-8111-111111111111";

function health(overrides: Partial<OnboardingSetupHealth> = {}): OnboardingSetupHealth {
  return {
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
      checkedAt: "2026-05-16T18:00:01.000Z",
      connected: true,
      credentialType: "codex_access_token",
      expiresAt: "2026-05-16T20:00:00.000Z",
      reconnectReason: null,
      reconnectRequired: false,
      status: "connected",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    claudeCodeConnection: {
      checkedAt: "2026-05-16T18:00:01.000Z",
      connected: true,
      status: "connected",
      updatedAt: "2026-05-16T18:00:00.000Z",
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
    latestSandboxCapabilityCheck: {
      capabilities: {},
      checkedAt: "2026-05-16T18:00:00.000Z",
      errorText: null,
      githubRepositoryId: repositoryId,
      id: "check-1",
      sandboxProvider: "vercel",
      sandboxVercelProjectId: "prj_123",
      sandboxVercelTeamId: "team_123",
      status: "success",
    },
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
      configured: true,
      fullName: "acme/app",
      repositoryId,
      status: "ready",
    },
    linearKey: { configured: true, status: "present", updatedAt: "2026-05-16T18:00:00.000Z" },
    linearRouting: { configured: true, status: "present", updatedAt: "2026-05-16T18:00:00.000Z" },
    primaryRepositoryProfile: {
      configured: true,
      fullName: "acme/app",
      repositoryId,
      status: "ready",
    },
    repositorySetup: {
      configured: true,
      repositoryId,
      status: "ready",
    },
    workspaceSecrets: {
      configuredKeys: ["LINEAR_API_KEY"],
    },
    ...overrides,
  };
}

function onboarding(overrides: Partial<WorkspaceOnboardingState> = {}): WorkspaceOnboardingState {
  return {
    completedAt: null,
    completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
    createdAt: "2026-05-16T18:00:00.000Z",
    currentStep: "verify",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: repositoryId,
    skippedSteps: [],
    status: "in_progress",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("buildRuntimeReadiness", () => {
  it("requires Codex connection for the codex provider", () => {
    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_model: "gpt-5.5", agent_provider: "codex" },
        claudeCodeConnection: health().claudeCodeConnection,
        codexConnection: health().codexConnection,
        primaryRepositoryId: repositoryId,
        repositorySetup: health().repositorySetup,
      }).canComplete,
    ).toBe(true);

    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_model: "gpt-5.5", agent_provider: "codex" },
        claudeCodeConnection: health().claudeCodeConnection,
        codexConnection: {
          checkedAt: "2026-05-16T18:00:01.000Z",
          connected: false,
          credentialType: null,
          expiresAt: null,
          reconnectReason: null,
          reconnectRequired: false,
          status: "missing",
          updatedAt: null,
        },
        primaryRepositoryId: repositoryId,
        repositorySetup: health().repositorySetup,
      }).canComplete,
    ).toBe(false);
  });

  it("requires claude-* models and ready repository setup for claude-code", () => {
    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_model: "gpt-5-codex", agent_provider: "claude-code" },
        claudeCodeConnection: health().claudeCodeConnection,
        codexConnection: health().codexConnection,
        primaryRepositoryId: repositoryId,
        repositorySetup: health().repositorySetup,
      }).canComplete,
    ).toBe(false);

    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_model: "claude-opus-4-7[1m]", agent_provider: "claude-code" },
        claudeCodeConnection: health().claudeCodeConnection,
        codexConnection: health().codexConnection,
        primaryRepositoryId: repositoryId,
        repositorySetup: { configured: false, repositoryId, status: "not_set_up" },
      }).canComplete,
    ).toBe(false);
  });

  it("requires an Anthropic API key for claude-code", () => {
    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_model: "claude-opus-4-7[1m]", agent_provider: "claude-code" },
        claudeCodeConnection: {
          checkedAt: "2026-05-16T18:00:01.000Z",
          connected: false,
          status: "missing",
          updatedAt: null,
        },
        codexConnection: health().codexConnection,
        primaryRepositoryId: repositoryId,
        repositorySetup: health().repositorySetup,
      }).canComplete,
    ).toBe(false);
  });

  it("resolves an unset model from the selected provider", () => {
    expect(
      buildRuntimeReadiness({
        agentConfig: { agent_provider: "claude-code" },
        claudeCodeConnection: health().claudeCodeConnection,
        codexConnection: health().codexConnection,
        primaryRepositoryId: repositoryId,
        repositorySetup: health().repositorySetup,
      }).model,
    ).toBe("claude-opus-4-7[1m]");
  });
});

describe("buildVerifyChecklist", () => {
  it("returns no blockers when all verification requirements pass", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health(),
      onboarding: onboarding(),
    });

    expect(verifyBlockersFromChecklist(checklist)).toEqual([]);
  });

  it("links blockers to their owning onboarding steps", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: { agent_model: "gpt-5.5", agent_provider: "codex" },
      health: health({
        latestSandboxCapabilityCheck: null,
        repositorySetup: { configured: false, repositoryId, status: "conflict" },
      }),
      onboarding: onboarding({ completedSteps: ["github", "repository", "pipeline"] }),
    });

    expect(verifyBlockersFromChecklist(checklist)).toMatchObject([
      { id: "repository-setup", step: "repository" },
      { id: "linear", step: "linear" },
      { id: "runtime", step: "runtime" },
      { id: "sandbox", step: "verify" },
    ]);
  });

  it("labels sandbox checklist state without treating every non-success as blocked", () => {
    const sandboxItem = (checkHealth: Partial<OnboardingSetupHealth>) =>
      buildVerifyChecklist({
        agentConfig: health().agentConfig.values,
        health: health(checkHealth),
        onboarding: onboarding(),
      }).find((item) => item.id === "sandbox");

    expect(sandboxItem({ latestSandboxCapabilityCheck: null })).toMatchObject({
      passed: false,
      statusLabel: "Not started",
      statusTone: "neutral",
    });
    expect(
      sandboxItem({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-05-16T18:00:00.000Z",
          errorText: null,
          githubRepositoryId: repositoryId,
          id: "check-2",
          sandboxProvider: null,
          sandboxVercelProjectId: null,
          sandboxVercelTeamId: null,
          status: "running",
        },
      }),
    ).toMatchObject({ passed: false, statusLabel: "Running", statusTone: "accent" });
    expect(
      sandboxItem({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-05-16T18:00:00.000Z",
          errorText: "sandbox failed",
          githubRepositoryId: repositoryId,
          id: "check-3",
          sandboxProvider: "vercel",
          sandboxVercelProjectId: "prj_123",
          sandboxVercelTeamId: "team_123",
          status: "error",
        },
      }),
    ).toMatchObject({ passed: false, statusLabel: "Failed", statusTone: "danger" });
    expect(
      sandboxItem({
        latestSandboxCapabilityCheck: null,
        primaryRepositoryProfile: {
          configured: false,
          fullName: null,
          repositoryId: null,
          status: "missing",
        },
      }),
    ).toMatchObject({ passed: false, statusLabel: "Unavailable", statusTone: "neutral" });
  });

  it("labels unfinished onboarding steps as 'Not finished', never 'Blocked', so Health and Verify never contradict", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      // Pipeline is objectively ready in Health, but its step is not yet completed.
      health: health(),
      onboarding: onboarding({ completedSteps: ["github", "repository"] }),
    });
    const item = (id: string) => checklist.find((entry) => entry.id === id);

    expect(item("pipeline")).toMatchObject({
      passed: false,
      statusLabel: "Not finished",
      statusTone: "neutral",
    });
    expect(item("linear")).toMatchObject({
      passed: false,
      statusLabel: "Not finished",
      statusTone: "neutral",
    });
    expect(item("runtime")).toMatchObject({
      passed: false,
      statusLabel: "Not finished",
      statusTone: "neutral",
    });
    // No onboarding step-completion item may render the warning "Blocked" vocabulary.
    for (const id of ["pipeline", "linear", "runtime"]) {
      expect(item(id)?.statusTone).not.toBe("warning");
    }
  });

  it("marks finished onboarding steps as 'Done'", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health(),
      onboarding: onboarding(),
    });
    const item = (id: string) => checklist.find((entry) => entry.id === id);

    expect(item("pipeline")).toMatchObject({ passed: true, statusLabel: "Done" });
    expect(item("linear")).toMatchObject({ passed: true, statusLabel: "Done" });
    expect(item("runtime")).toMatchObject({ passed: true, statusLabel: "Done" });
  });

  it("keeps Settings-mode readiness vocabulary (no step-completion override)", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health({
        defaultPipeline: { configured: false, pipelineId: null, stageCount: 0, status: "missing" },
      }),
      mode: "settings",
      onboarding: onboarding({ completedSteps: [], skippedSteps: [] }),
    });
    const pipeline = checklist.find((entry) => entry.id === "pipeline");

    // Settings mode tracks readiness, so an unconfigured pipeline keeps the default
    // Ready/Blocked vocabulary (no statusLabel override) consistent with Health.
    expect(pipeline?.passed).toBe(false);
    expect(pipeline?.statusLabel).toBeUndefined();
    expect(pipeline?.statusTone).toBeUndefined();
  });

  it("treats skipped optional steps as satisfied", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health(),
      onboarding: onboarding({
        completedSteps: ["github", "repository", "pipeline"],
        skippedSteps: ["linear", "runtime"],
      }),
    });

    expect(verifyBlockersFromChecklist(checklist)).toEqual([]);
  });

  it("can verify Settings from setup health instead of onboarding step flags", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health(),
      mode: "settings",
      onboarding: onboarding({
        completedSteps: [],
        skippedSteps: [],
      }),
    });

    expect(verifyBlockersFromChecklist(checklist)).toEqual([]);
  });

  it("does not let stale onboarding Linear completion override Settings health", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health({
        linearKey: { configured: false, status: "missing", updatedAt: null },
      }),
      mode: "settings",
      onboarding: onboarding({
        completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
      }),
    });

    expect(verifyBlockersFromChecklist(checklist)).toEqual([
      {
        detail: "Configure the Linear API key and routing.",
        id: "linear",
        label: "Linear configured",
        step: "linear",
      },
    ]);
  });

  it("blocks sandbox checks that belong to a different repository", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-05-16T18:00:00.000Z",
          errorText: null,
          githubRepositoryId: "22222222-2222-4222-8222-222222222222",
          id: "check-2",
          sandboxProvider: "vercel",
          sandboxVercelProjectId: "prj_123",
          sandboxVercelTeamId: "team_123",
          status: "success",
        },
      }),
      onboarding: onboarding(),
    });
    const sandboxItem = checklist.find((item) => item.id === "sandbox");

    expect(sandboxItem).toMatchObject({
      detail: "Run a sandbox capability check for the selected repository.",
      passed: false,
    });
  });

  it("blocks successful sandbox checks from a previous Vercel project", () => {
    const checklist = buildVerifyChecklist({
      agentConfig: health().agentConfig.values,
      health: health({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-05-16T18:00:00.000Z",
          errorText: null,
          githubRepositoryId: repositoryId,
          id: "check-2",
          sandboxProvider: "vercel",
          sandboxVercelProjectId: "prj_old",
          sandboxVercelTeamId: "team_123",
          status: "success",
        },
      }),
      onboarding: onboarding(),
    });
    const sandboxItem = checklist.find((item) => item.id === "sandbox");

    expect(sandboxItem).toMatchObject({
      detail: "Run a sandbox capability check for the connected Vercel project.",
      passed: false,
      statusLabel: "Stale",
      statusTone: "warning",
    });
  });
});
