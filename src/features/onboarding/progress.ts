import {
  canSkipOnboardingStep,
  ONBOARDING_STEPS,
  onboardingStepIndex,
  type OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import {
  isActionableSandboxCapabilityFailure,
  type RuntimeReadiness,
} from "@/features/onboarding/runtime-readiness";
import {
  normalizeAgentProviderName,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
} from "@/lib/agent-config/contracts";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingState,
  WorkspaceOnboardingStep,
} from "@/lib/onboarding/contracts";
import { WORKSPACE_ONBOARDING_STEPS } from "@/lib/onboarding/contracts";

export const REQUIRED_ONBOARDING_STEPS = [
  "github",
  "repository",
  "pipeline",
  "verify",
] as const satisfies readonly WorkspaceOnboardingStep[];

export type RequiredOnboardingStep = (typeof REQUIRED_ONBOARDING_STEPS)[number];

export const ONBOARDING_FOCUS_TARGETS = {
  github: "onboarding-focus-github",
  linear: "onboarding-focus-linear",
  pipeline: "onboarding-focus-pipeline",
  repository: "onboarding-focus-repository",
  runtime: "onboarding-focus-runtime",
  verify: "onboarding-focus-verify",
} as const satisfies Record<WorkspaceOnboardingStep, string>;

export type OnboardingProgressSummary = {
  completedCount: number;
  currentIndex: number;
  currentStepName: string;
  percentComplete: number;
  positionLabel: string;
  remainingRequiredCount: number;
  remainingRequiredLabel: string;
  totalSteps: number;
};

export type OnboardingPrimaryAction = {
  disabled: boolean;
  focusTargetId: string | null;
  idleLabel: string;
  reason: string | null;
  reasonActionLabel: string | null;
};

export type OnboardingStepStatusPresentation = {
  description: string;
  label: string;
  statusValue:
    | "blocked"
    | "complete"
    | "failed"
    | "not_started"
    | "running"
    | "skipped"
    | "upcoming";
};

const STEP_STATUS_PRESENTATION = {
  blocked: {
    description: "Earlier required setup must be finished before this step can complete.",
    label: "Blocked",
    statusValue: "blocked",
  },
  completed: {
    description: "This step is complete.",
    label: "Complete",
    statusValue: "complete",
  },
  current: {
    description: "You are on this step.",
    label: "Current",
    statusValue: "running",
  },
  error: {
    description: "This step needs attention before setup can continue.",
    label: "Error",
    statusValue: "failed",
  },
  skipped: {
    description: "Skipped for now. Still incomplete and revisitable.",
    label: "Skipped",
    statusValue: "skipped",
  },
  upcoming: {
    description: "This step has not started yet.",
    label: "Upcoming",
    statusValue: "upcoming",
  },
} as const satisfies Record<OnboardingStepDisplayState, OnboardingStepStatusPresentation>;

export function isRequiredOnboardingStep(
  step: WorkspaceOnboardingStep,
): step is RequiredOnboardingStep {
  return (REQUIRED_ONBOARDING_STEPS as readonly string[]).includes(step);
}

export function stepIsSatisfied(
  onboarding: WorkspaceOnboardingState,
  step: WorkspaceOnboardingStep,
) {
  if (onboarding.status === "completed") return true;
  if (onboarding.completedSteps.includes(step)) return true;
  return canSkipOnboardingStep(step) && onboarding.skippedSteps.includes(step);
}

export function firstIncompleteRequiredStep(
  onboarding: WorkspaceOnboardingState,
  options?: { excludeSteps?: ReadonlySet<WorkspaceOnboardingStep> },
): WorkspaceOnboardingStep | null {
  if (onboarding.status === "completed") return null;

  for (const step of REQUIRED_ONBOARDING_STEPS) {
    if (options?.excludeSteps?.has(step)) continue;
    if (!onboarding.completedSteps.includes(step)) {
      return step;
    }
  }

  return null;
}

export function shouldResumeToFirstIncompleteRequired(
  onboarding: WorkspaceOnboardingState,
  options?: { excludeSteps?: ReadonlySet<WorkspaceOnboardingStep> },
) {
  const resumeStep = firstIncompleteRequiredStep(onboarding, options);
  if (!resumeStep || onboarding.status === "completed") return null;
  if (onboardingStepIndex(onboarding.currentStep) <= onboardingStepIndex(resumeStep)) {
    return null;
  }
  return resumeStep;
}

export function getOnboardingProgressSummary(
  onboarding: WorkspaceOnboardingState,
): OnboardingProgressSummary {
  const totalSteps = WORKSPACE_ONBOARDING_STEPS.length;
  const currentIndex = onboardingStepIndex(onboarding.currentStep) + 1;
  const completedCount =
    onboarding.status === "completed"
      ? totalSteps
      : onboarding.completedSteps.filter((step) => WORKSPACE_ONBOARDING_STEPS.includes(step))
          .length;
  const percentComplete = Math.round((completedCount / totalSteps) * 100);
  const remainingRequiredCount =
    onboarding.status === "completed"
      ? 0
      : REQUIRED_ONBOARDING_STEPS.filter((step) => !onboarding.completedSteps.includes(step))
          .length;
  const currentStepName =
    ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)?.title ??
    onboarding.currentStep;

  return {
    completedCount,
    currentIndex,
    currentStepName,
    percentComplete,
    positionLabel: `Step ${currentIndex} of ${totalSteps}`,
    remainingRequiredCount,
    remainingRequiredLabel:
      remainingRequiredCount === 0
        ? "All required steps complete"
        : `${remainingRequiredCount} required ${remainingRequiredCount === 1 ? "step" : "steps"} remaining`,
    totalSteps,
  };
}

export function onboardingStepStatusPresentation(
  state: OnboardingStepDisplayState,
): OnboardingStepStatusPresentation {
  return STEP_STATUS_PRESENTATION[state];
}

function selectedAgentProvider(health: OnboardingSetupHealth) {
  const rawProvider = health.agentConfig.values.agent_provider;
  return typeof rawProvider === "string"
    ? (normalizeAgentProviderName(rawProvider) ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider)
    : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
}

export function deriveOnboardingStepHealthFlags(
  health: OnboardingSetupHealth,
  onboarding: WorkspaceOnboardingState,
): {
  blockedSteps: Set<WorkspaceOnboardingStep>;
  errorSteps: Set<WorkspaceOnboardingStep>;
} {
  const errorSteps = new Set<WorkspaceOnboardingStep>();
  const blockedSteps = new Set<WorkspaceOnboardingStep>();
  const provider = selectedAgentProvider(health);
  const githubWasCompleted =
    onboarding.status === "completed" || onboarding.completedSteps.includes("github");
  const runtimeWasCompleted =
    onboarding.status === "completed" || onboarding.completedSteps.includes("runtime");
  const selectedProviderConnected =
    provider === "codex" ? health.codexConnection.connected : health.claudeCodeConnection.connected;

  // Suspended installs and deleted installs (connected=false after prior completion)
  // are regressions — surface them as rail errors over historical Complete.
  if (
    health.githubInstallation.suspended ||
    (!health.githubInstallation.connected && githubWasCompleted)
  ) {
    errorSteps.add("github");
  }
  if (provider === "codex" && health.codexConnection.status === "expired") {
    errorSteps.add("runtime");
  }
  if (health.vercelSandboxConnection.status === "error") {
    errorSteps.add("runtime");
  }
  // Missing selected-provider or Vercel after Runtime completion is a regression —
  // status is `missing` (not expired/error), so the checks above would miss it.
  if (
    runtimeWasCompleted &&
    (!selectedProviderConnected || !health.vercelSandboxConnection.connected)
  ) {
    errorSteps.add("runtime");
  }
  if (isActionableSandboxCapabilityFailure(health)) {
    errorSteps.add("verify");
  }

  if (!health.githubInstallation.connected) {
    blockedSteps.add("repository");
    blockedSteps.add("runtime");
    blockedSteps.add("verify");
  } else if (!health.selectedRepository.configured) {
    blockedSteps.add("runtime");
    blockedSteps.add("verify");
  } else if (!health.primaryRepositoryProfile.configured) {
    blockedSteps.add("runtime");
    blockedSteps.add("verify");
  }

  if (!health.defaultPipeline.configured) {
    blockedSteps.add("linear");
    blockedSteps.add("verify");
  }

  return { blockedSteps, errorSteps };
}

export function buildOnboardingPrimaryAction(input: {
  activeStepAlreadyResolved: boolean;
  activeStepId: WorkspaceOnboardingStep;
  githubContinueBlocked: boolean;
  hasInvalidRuntimeDrafts: boolean;
  hasUnsavedRuntimeDrafts: boolean;
  inlineCompletionLabel: string | null;
  isCompleted: boolean;
  repositoryContinueBlocked: boolean;
  requiresInlineCompletion: boolean;
  runtimeCompletionBlocked: boolean;
  runtimeReadiness: RuntimeReadiness;
  vercelConnected: boolean;
  verifyCompletionBlocked: boolean;
  verifyFirstBlockerLabel: string | null;
  verifyFirstBlockerStep: WorkspaceOnboardingStep | null;
}): OnboardingPrimaryAction {
  if (input.isCompleted) {
    return {
      disabled: true,
      focusTargetId: null,
      idleLabel: "Setup complete",
      reason: null,
      reasonActionLabel: null,
    };
  }

  const idleLabel = (() => {
    if (input.requiresInlineCompletion && input.inlineCompletionLabel) {
      return input.inlineCompletionLabel;
    }
    switch (input.activeStepId) {
      case "github":
        return "Verify GitHub and continue";
      case "repository":
        return "Continue with analyzed repository";
      case "pipeline":
        return "Continue with pipeline";
      case "linear":
        return "Connect Linear and continue";
      case "runtime":
        return "Connect Agent and continue";
      case "verify":
        return "Complete setup";
    }
  })();

  if (input.githubContinueBlocked) {
    return {
      disabled: true,
      focusTargetId: ONBOARDING_FOCUS_TARGETS.github,
      idleLabel,
      reason: "Connect GitHub and sync at least one active repository.",
      reasonActionLabel: "Resolve GitHub connection",
    };
  }

  if (input.repositoryContinueBlocked) {
    return {
      disabled: true,
      focusTargetId: ONBOARDING_FOCUS_TARGETS.repository,
      idleLabel,
      reason: "Select a repository, save its profile, and finish Wallie setup.",
      reasonActionLabel: "Resolve repository setup",
    };
  }

  if (input.requiresInlineCompletion) {
    return {
      disabled: true,
      focusTargetId:
        input.activeStepId === "linear"
          ? ONBOARDING_FOCUS_TARGETS.linear
          : ONBOARDING_FOCUS_TARGETS.pipeline,
      idleLabel,
      reason:
        input.activeStepId === "linear"
          ? "Save the Linear key, routing, and connection test to continue."
          : "Save the pipeline in this step to continue.",
      reasonActionLabel:
        input.activeStepId === "linear" ? "Go to Linear setup" : "Go to pipeline editor",
    };
  }

  if (input.runtimeCompletionBlocked && !input.activeStepAlreadyResolved) {
    const firstRequirement = input.runtimeReadiness.requirements.find((item) => !item.passed);
    const reason = !input.vercelConnected
      ? "Connect a Vercel sandbox project before continuing."
      : input.hasInvalidRuntimeDrafts
        ? "Fix invalid agent settings before continuing."
        : input.hasUnsavedRuntimeDrafts
          ? "Save agent settings before continuing."
          : (firstRequirement?.detail ?? "Finish agent runtime readiness before continuing.");
    return {
      disabled: true,
      focusTargetId: ONBOARDING_FOCUS_TARGETS.runtime,
      idleLabel,
      reason,
      reasonActionLabel: "Resolve agent setup",
    };
  }

  if (input.verifyCompletionBlocked) {
    return {
      disabled: true,
      focusTargetId: input.verifyFirstBlockerStep
        ? ONBOARDING_FOCUS_TARGETS[input.verifyFirstBlockerStep]
        : ONBOARDING_FOCUS_TARGETS.verify,
      idleLabel,
      reason: input.verifyFirstBlockerLabel
        ? `Blocked: ${input.verifyFirstBlockerLabel}.`
        : "Resolve readiness blockers before completing setup.",
      reasonActionLabel: input.verifyFirstBlockerStep
        ? `Open ${ONBOARDING_STEPS.find((step) => step.id === input.verifyFirstBlockerStep)?.shortTitle ?? "step"}`
        : "Review checklist",
    };
  }

  return {
    disabled: false,
    focusTargetId: null,
    idleLabel,
    reason: null,
    reasonActionLabel: null,
  };
}
