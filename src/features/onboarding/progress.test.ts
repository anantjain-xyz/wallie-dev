import { describe, expect, it } from "vitest";

import {
  buildOnboardingPrimaryAction,
  deriveOnboardingStepHealthFlags,
  firstIncompleteRequiredStep,
  getOnboardingProgressSummary,
  onboardingStepStatusPresentation,
  shouldResumeToFirstIncompleteRequired,
} from "@/features/onboarding/progress";
import type { OnboardingSetupHealth, WorkspaceOnboardingState } from "@/lib/onboarding/contracts";

function onboarding(overrides: Partial<WorkspaceOnboardingState> = {}): WorkspaceOnboardingState {
  return {
    completedAt: null,
    completedSteps: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    currentStep: "github",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: null,
    skippedSteps: [],
    status: "in_progress",
    updatedAt: "2026-07-18T00:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function health(overrides: Partial<OnboardingSetupHealth> = {}): OnboardingSetupHealth {
  return {
    agentConfig: {
      configured: false,
      configuredKeys: [],
      status: "missing",
      values: {},
    },
    claudeCodeConnection: {
      checkedAt: "2026-07-18T00:00:00.000Z",
      connected: false,
      status: "missing",
      updatedAt: null,
    },
    codexConnection: {
      accountEmail: null,
      checkedAt: "2026-07-18T00:00:00.000Z",
      connected: false,
      credentialType: null,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      status: "missing",
      updatedAt: null,
    },
    defaultPipeline: {
      configured: true,
      pipelineId: "pipeline-1",
      stageCount: 3,
      status: "ready",
    },
    githubInstallation: {
      connected: false,
      installationId: null,
      status: "missing",
      suspended: null,
      targetName: null,
      updatedAt: null,
    },
    latestSandboxCapabilityCheck: null,
    linearKey: { configured: false, status: "missing", updatedAt: null },
    linearRouting: { configured: true, status: "present", updatedAt: null },
    primaryRepositoryProfile: {
      configured: false,
      fullName: null,
      repositoryId: null,
      status: "missing",
    },
    repositorySetup: {
      configured: false,
      repositoryId: null,
      status: "not_set_up",
    },
    selectedRepository: {
      configured: false,
      fullName: null,
      repositoryId: null,
      status: "missing",
    },
    vercelSandboxConnection: {
      connected: false,
      lastValidationError: null,
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
      updatedAt: null,
    },
    workspaceSecrets: { configuredKeys: [] },
    ...overrides,
  };
}

describe("onboarding progress helpers", () => {
  it("keeps completed and skipped presentation visually distinct", () => {
    const completed = onboardingStepStatusPresentation("completed");
    const skipped = onboardingStepStatusPresentation("skipped");
    expect(completed.label).not.toEqual(skipped.label);
    expect(completed.statusValue).not.toEqual(skipped.statusValue);
    expect(completed.label).toBe("Complete");
    expect(skipped.label).toBe("Skipped");
  });

  it("summarizes position, percent, and remaining required work", () => {
    expect(
      getOnboardingProgressSummary(
        onboarding({
          completedSteps: ["github", "repository"],
          currentStep: "pipeline",
        }),
      ),
    ).toMatchObject({
      currentStepName: "Review pipeline",
      percentComplete: 33,
      positionLabel: "Step 3 of 6",
      remainingRequiredCount: 2,
      remainingRequiredLabel: "2 required steps remaining",
    });
  });

  it("resumes to the first incomplete required step when current is ahead", () => {
    const partial = onboarding({
      completedSteps: ["github"],
      currentStep: "verify",
    });
    expect(firstIncompleteRequiredStep(partial)).toBe("repository");
    expect(shouldResumeToFirstIncompleteRequired(partial)).toBe("repository");
    expect(
      shouldResumeToFirstIncompleteRequired(
        onboarding({
          completedSteps: ["github", "repository", "pipeline"],
          currentStep: "linear",
        }),
      ),
    ).toBeNull();
  });

  it("does not resume to an unavailable pipeline the user already advanced past", () => {
    const advancedPastUnavailablePipeline = onboarding({
      completedSteps: ["github", "repository"],
      currentStep: "linear",
    });
    expect(firstIncompleteRequiredStep(advancedPastUnavailablePipeline)).toBe("pipeline");
    expect(shouldResumeToFirstIncompleteRequired(advancedPastUnavailablePipeline)).toBe("pipeline");
    expect(
      shouldResumeToFirstIncompleteRequired(advancedPastUnavailablePipeline, {
        excludeSteps: new Set(["pipeline"]),
      }),
    ).toBeNull();
    expect(
      firstIncompleteRequiredStep(advancedPastUnavailablePipeline, {
        excludeSteps: new Set(["pipeline"]),
      }),
    ).toBe("verify");
  });

  it("flags disconnected runtime dependencies as errors after prior completion", () => {
    const missingRuntime = health({
      agentConfig: {
        configured: true,
        configuredKeys: ["agent_provider"],
        status: "present",
        values: { agent_provider: "codex" },
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: "2026-07-18T00:00:00.000Z",
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "missing",
        updatedAt: null,
      },
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
        updatedAt: null,
      },
    });

    expect(
      deriveOnboardingStepHealthFlags(missingRuntime, onboarding()).errorSteps.has("runtime"),
    ).toBe(false);
    expect(
      deriveOnboardingStepHealthFlags(
        missingRuntime,
        onboarding({
          completedSteps: ["github", "repository", "pipeline", "runtime"],
          currentStep: "verify",
        }),
      ).errorSteps.has("runtime"),
    ).toBe(true);

    const vercelOnlyMissing = health({
      agentConfig: {
        configured: true,
        configuredKeys: ["agent_provider"],
        status: "present",
        values: { agent_provider: "codex" },
      },
      codexConnection: {
        accountEmail: "owner@example.com",
        checkedAt: "2026-07-18T00:00:00.000Z",
        connected: true,
        credentialType: "chatgpt_auth_json",
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "connected",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
        updatedAt: null,
      },
    });
    expect(
      deriveOnboardingStepHealthFlags(
        vercelOnlyMissing,
        onboarding({
          completedSteps: ["github", "repository", "pipeline", "runtime"],
          currentStep: "verify",
        }),
      ).errorSteps.has("runtime"),
    ).toBe(true);
  });

  it("covers configured, partial, blocked, and failed health fixtures", () => {
    const baseOnboarding = onboarding({
      completedSteps: ["github"],
      currentStep: "repository",
    });
    const configured = deriveOnboardingStepHealthFlags(
      health({
        githubInstallation: {
          connected: true,
          installationId: 1,
          status: "present",
          suspended: false,
          targetName: "acme",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        primaryRepositoryProfile: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        selectedRepository: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
      }),
      baseOnboarding,
    );
    expect([...configured.blockedSteps]).toEqual([]);
    expect([...configured.errorSteps]).toEqual([]);

    const partial = deriveOnboardingStepHealthFlags(
      health({
        githubInstallation: {
          connected: true,
          installationId: 1,
          status: "present",
          suspended: false,
          targetName: "acme",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      baseOnboarding,
    );
    expect(partial.blockedSteps.has("runtime")).toBe(true);
    expect(partial.blockedSteps.has("verify")).toBe(true);

    const failed = deriveOnboardingStepHealthFlags(
      health({
        githubInstallation: {
          connected: true,
          installationId: 1,
          status: "present",
          suspended: true,
          targetName: "acme",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        latestSandboxCapabilityCheck: {
          capabilities: {
            git: { detail: "failed", ok: false },
            node: { detail: "failed", ok: false },
          },
          checkedAt: "2026-07-18T00:00:00.000Z",
          errorText: "boom",
          githubRepositoryId: "repo-1",
          id: "check-1",
          sandboxProvider: "vercel",
          sandboxVercelProjectId: "prj_1",
          sandboxVercelTeamId: "team_1",
          status: "error",
        },
        primaryRepositoryProfile: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        selectedRepository: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        vercelSandboxConnection: {
          connected: true,
          lastValidationError: null,
          projectId: "prj_1",
          projectName: "wallie",
          status: "connected",
          teamId: "team_1",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      baseOnboarding,
    );
    expect(failed.errorSteps.has("github")).toBe(true);
    expect(failed.errorSteps.has("verify")).toBe(true);

    const vercelRuntimeError = deriveOnboardingStepHealthFlags(
      health({
        vercelSandboxConnection: {
          connected: false,
          lastValidationError: "invalid token",
          projectId: null,
          projectName: null,
          status: "error",
          teamId: null,
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      onboarding(),
    );
    expect(vercelRuntimeError.errorSteps.has("runtime")).toBe(true);
  });

  it("treats deleted GitHub installations as errors after prior completion", () => {
    const deletedInstall = health({
      githubInstallation: {
        connected: false,
        installationId: null,
        status: "missing",
        suspended: null,
        targetName: null,
        updatedAt: null,
      },
    });

    expect(
      deriveOnboardingStepHealthFlags(deletedInstall, onboarding()).errorSteps.has("github"),
    ).toBe(false);
    expect(
      deriveOnboardingStepHealthFlags(
        deletedInstall,
        onboarding({ completedSteps: ["github"], currentStep: "repository" }),
      ).errorSteps.has("github"),
    ).toBe(true);
    expect(
      deriveOnboardingStepHealthFlags(
        deletedInstall,
        onboarding({ completedSteps: ["github"], currentStep: "verify", status: "completed" }),
      ).errorSteps.has("github"),
    ).toBe(true);
  });

  it("scopes Codex expiration errors to the selected agent provider", () => {
    const expiredCodexWhileClaudeSelected = deriveOnboardingStepHealthFlags(
      health({
        agentConfig: {
          configured: true,
          configuredKeys: ["agent_provider"],
          status: "present",
          values: { agent_provider: "claude-code" },
        },
        codexConnection: {
          accountEmail: null,
          checkedAt: "2026-07-18T00:00:00.000Z",
          connected: false,
          credentialType: null,
          expiresAt: null,
          reconnectReason: null,
          reconnectRequired: true,
          status: "expired",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      onboarding(),
    );
    expect(expiredCodexWhileClaudeSelected.errorSteps.has("runtime")).toBe(false);

    const expiredCodexWhileCodexSelected = deriveOnboardingStepHealthFlags(
      health({
        agentConfig: {
          configured: true,
          configuredKeys: ["agent_provider"],
          status: "present",
          values: { agent_provider: "codex" },
        },
        codexConnection: {
          accountEmail: null,
          checkedAt: "2026-07-18T00:00:00.000Z",
          connected: false,
          credentialType: null,
          expiresAt: null,
          reconnectReason: null,
          reconnectRequired: true,
          status: "expired",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      onboarding(),
    );
    expect(expiredCodexWhileCodexSelected.errorSteps.has("runtime")).toBe(true);
  });

  it("ignores stale sandbox capability failures from prior Vercel connections", () => {
    const stale = deriveOnboardingStepHealthFlags(
      health({
        latestSandboxCapabilityCheck: {
          capabilities: {
            git: { detail: "failed", ok: false },
            node: { detail: "failed", ok: false },
          },
          checkedAt: "2026-07-18T00:00:00.000Z",
          errorText: "old project failed",
          githubRepositoryId: "repo-1",
          id: "check-stale",
          sandboxProvider: "vercel",
          sandboxVercelProjectId: "prj_old",
          sandboxVercelTeamId: "team_old",
          status: "error",
        },
        primaryRepositoryProfile: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        selectedRepository: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        vercelSandboxConnection: {
          connected: true,
          lastValidationError: null,
          projectId: "prj_new",
          projectName: "wallie",
          status: "connected",
          teamId: "team_new",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      onboarding({ completedSteps: ["github"], currentStep: "verify" }),
    );
    expect(stale.errorSteps.has("verify")).toBe(false);
  });

  it("flags capability errors raised before sandbox metadata exists", () => {
    const earlyFailure = deriveOnboardingStepHealthFlags(
      health({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-07-18T00:00:00.000Z",
          errorText: "Failed to mint installation token",
          githubRepositoryId: "repo-1",
          id: "check-early",
          sandboxProvider: null,
          sandboxVercelProjectId: null,
          sandboxVercelTeamId: null,
          status: "error",
        },
        primaryRepositoryProfile: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        selectedRepository: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        vercelSandboxConnection: {
          connected: true,
          lastValidationError: null,
          projectId: "prj_new",
          projectName: "wallie",
          status: "connected",
          teamId: "team_new",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      }),
      onboarding({ completedSteps: ["github"], currentStep: "verify" }),
    );
    expect(earlyFailure.errorSteps.has("verify")).toBe(true);
  });

  it("does not retain early-check capability errors after Vercel disconnects", () => {
    const afterDisconnect = deriveOnboardingStepHealthFlags(
      health({
        latestSandboxCapabilityCheck: {
          capabilities: {},
          checkedAt: "2026-07-18T00:00:00.000Z",
          errorText: "Failed to mint installation token",
          githubRepositoryId: "repo-1",
          id: "check-early",
          sandboxProvider: null,
          sandboxVercelProjectId: null,
          sandboxVercelTeamId: null,
          status: "error",
        },
        primaryRepositoryProfile: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        selectedRepository: {
          configured: true,
          fullName: "acme/repo",
          repositoryId: "repo-1",
          status: "ready",
        },
        vercelSandboxConnection: {
          connected: false,
          lastValidationError: null,
          projectId: null,
          projectName: null,
          status: "missing",
          teamId: null,
          updatedAt: null,
        },
      }),
      onboarding({ completedSteps: ["github"], currentStep: "verify" }),
    );
    expect(afterDisconnect.errorSteps.has("verify")).toBe(false);
  });

  it("builds operation-specific primary actions with disabled reasons", () => {
    const blockedGithub = buildOnboardingPrimaryAction({
      activeStepAlreadyResolved: false,
      activeStepId: "github",
      githubContinueBlocked: true,
      hasInvalidRuntimeDrafts: false,
      hasUnsavedRuntimeDrafts: false,
      inlineCompletionLabel: null,
      isCompleted: false,
      repositoryContinueBlocked: false,
      requiresInlineCompletion: false,
      runtimeCompletionBlocked: false,
      runtimeReadiness: {
        canComplete: false,
        invalidConfig: [],
        missingDefaultKeys: [],
        model: "gpt-5.5",
        provider: "codex",
        requirements: [],
      },
      vercelConnected: false,
      verifyCompletionBlocked: false,
      verifyFirstBlockerLabel: null,
      verifyFirstBlockerStep: null,
    });
    expect(blockedGithub).toMatchObject({
      disabled: true,
      idleLabel: "Verify GitHub and continue",
      reasonActionLabel: "Resolve GitHub connection",
    });
    expect(blockedGithub.reason).toContain("Connect GitHub");

    const readyVerify = buildOnboardingPrimaryAction({
      activeStepAlreadyResolved: false,
      activeStepId: "verify",
      githubContinueBlocked: false,
      hasInvalidRuntimeDrafts: false,
      hasUnsavedRuntimeDrafts: false,
      inlineCompletionLabel: null,
      isCompleted: false,
      repositoryContinueBlocked: false,
      requiresInlineCompletion: false,
      runtimeCompletionBlocked: false,
      runtimeReadiness: {
        canComplete: true,
        invalidConfig: [],
        missingDefaultKeys: [],
        model: "gpt-5.5",
        provider: "codex",
        requirements: [],
      },
      vercelConnected: true,
      verifyCompletionBlocked: false,
      verifyFirstBlockerLabel: null,
      verifyFirstBlockerStep: null,
    });
    expect(readyVerify).toMatchObject({
      disabled: false,
      idleLabel: "Complete setup",
      reason: null,
    });
  });
});
