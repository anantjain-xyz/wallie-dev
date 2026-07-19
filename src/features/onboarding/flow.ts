import type {
  WorkspaceOnboardingState,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
export {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import {
  WORKSPACE_ONBOARDING_STEPS,
  workspaceOnboardingStatusSchema,
  workspaceOnboardingStepSchema,
} from "@/lib/onboarding/contracts";

export type OnboardingStepDefinition = {
  description: string;
  id: WorkspaceOnboardingStep;
  shortTitle: string;
  title: string;
};

export const ONBOARDING_STEPS: OnboardingStepDefinition[] = [
  {
    description: "Connect GitHub and sync the repositories Wallie can read.",
    id: "github",
    shortTitle: "GitHub",
    title: "Connect GitHub",
  },
  {
    description: "Prepare repositories by installing skills and saving inferred setup profiles.",
    id: "repository",
    shortTitle: "Analyze",
    title: "Analyze repositories",
  },
  {
    description: "Review the default phase pipeline before sessions start.",
    id: "pipeline",
    shortTitle: "Pipeline",
    title: "Review pipeline",
  },
  {
    description: "Add Linear credentials and routing for status updates.",
    id: "linear",
    shortTitle: "Linear",
    title: "Connect Linear",
  },
  {
    description: "Check coding-agent and sandbox runtime readiness.",
    id: "runtime",
    shortTitle: "Agent",
    title: "Connect Agent",
  },
  {
    description: "Confirm the setup health signals before starting work.",
    id: "verify",
    shortTitle: "Verify",
    title: "Verify setup",
  },
];

export const SKIPPABLE_ONBOARDING_STEPS = ["linear", "runtime"] as const;

type OnboardingResumeRow = { current_step: string; status: string } | null;

export type OnboardingStepDisplayState =
  | "blocked"
  | "completed"
  | "current"
  | "error"
  | "skipped"
  | "upcoming";

export type OnboardingStepRailContext = {
  blockedSteps?: ReadonlySet<WorkspaceOnboardingStep>;
  errorSteps?: ReadonlySet<WorkspaceOnboardingStep>;
};

export type OnboardingStepRailItem = OnboardingStepDefinition & {
  displayState: OnboardingStepDisplayState;
  isNavigable: boolean;
  position: number;
};

const STEP_INDEX = new Map<WorkspaceOnboardingStep, number>(
  WORKSPACE_ONBOARDING_STEPS.map((step, index) => [step, index]),
);

const REPOSITORY_SELECTION_DEPENDENT_STEPS = ["repository", "runtime", "verify"] as const;

export function onboardingStepIndex(step: WorkspaceOnboardingStep) {
  return STEP_INDEX.get(step) ?? 0;
}

export function mapOnboardingResumeState(row: OnboardingResumeRow): OnboardingResumeState | null {
  if (!row) {
    return {
      currentStep: "github",
      status: "not_started",
    };
  }

  return {
    currentStep: workspaceOnboardingStepSchema.parse(row.current_step),
    status: workspaceOnboardingStatusSchema.parse(row.status),
  };
}

export function canSkipOnboardingStep(step: WorkspaceOnboardingStep) {
  return SKIPPABLE_ONBOARDING_STEPS.includes(step as (typeof SKIPPABLE_ONBOARDING_STEPS)[number]);
}

function uniqueSteps(steps: WorkspaceOnboardingStep[]) {
  return WORKSPACE_ONBOARDING_STEPS.filter((step) => steps.includes(step));
}

function appendStep(
  steps: WorkspaceOnboardingStep[],
  step: WorkspaceOnboardingStep,
): WorkspaceOnboardingStep[] {
  return uniqueSteps([...steps, step]);
}

function removeStep(
  steps: WorkspaceOnboardingStep[],
  stepToRemove: WorkspaceOnboardingStep,
): WorkspaceOnboardingStep[] {
  return steps.filter((step) => step !== stepToRemove);
}

export function getOnboardingStepRailItems(
  onboarding: WorkspaceOnboardingState,
  context: OnboardingStepRailContext = {},
): OnboardingStepRailItem[] {
  const completed =
    onboarding.status === "completed"
      ? new Set<WorkspaceOnboardingStep>(WORKSPACE_ONBOARDING_STEPS)
      : new Set(onboarding.completedSteps);
  const skipped = new Set(onboarding.skippedSteps);
  const errorSteps = context.errorSteps ?? new Set<WorkspaceOnboardingStep>();
  const blockedSteps = context.blockedSteps ?? new Set<WorkspaceOnboardingStep>();

  return ONBOARDING_STEPS.map((step, index) => {
    let displayState: OnboardingStepDisplayState;

    // Active health errors win over historical completion so regressions stay visible.
    // Current-step identity for aria/mobile is derived from `onboarding.currentStep`
    // in the shell — an errored active step still renders as "error".
    if (errorSteps.has(step.id)) {
      displayState = "error";
    } else if (step.id === onboarding.currentStep) {
      displayState = "current";
    } else if (completed.has(step.id)) {
      displayState = "completed";
    } else if (skipped.has(step.id)) {
      displayState = "skipped";
    } else if (blockedSteps.has(step.id)) {
      displayState = "blocked";
    } else {
      displayState = "upcoming";
    }

    return {
      ...step,
      displayState,
      isNavigable: true,
      position: index + 1,
    };
  });
}

export function buildOnboardingContinuePatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload {
  const currentIndex = onboardingStepIndex(onboarding.currentStep);
  const completedSteps = appendStep(onboarding.completedSteps, onboarding.currentStep);
  const skippedSteps = removeStep(onboarding.skippedSteps, onboarding.currentStep);
  const nextStep = WORKSPACE_ONBOARDING_STEPS[currentIndex + 1];

  if (!nextStep) {
    return {
      completedSteps,
      currentStep: onboarding.currentStep,
      skippedSteps,
      status: "completed",
    };
  }

  return {
    completedSteps,
    currentStep: nextStep,
    skippedSteps,
    status: "in_progress",
  };
}

export function buildOnboardingStepCompletionPatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload | null {
  const currentIndex = onboardingStepIndex(onboarding.currentStep);
  const nextStep = WORKSPACE_ONBOARDING_STEPS[currentIndex + 1];

  if (!nextStep || onboarding.status === "completed") {
    return null;
  }

  return {
    completedSteps: appendStep(onboarding.completedSteps, onboarding.currentStep),
    skippedSteps: removeStep(onboarding.skippedSteps, onboarding.currentStep),
    status: "in_progress",
  };
}

export function buildOnboardingRepositorySelectionPatch(
  onboarding: WorkspaceOnboardingState,
  repositoryId: string,
  effectiveSelectedRepositoryId = onboarding.selectedGithubRepositoryId,
): WorkspaceOnboardingUpdatePayload | null {
  if (effectiveSelectedRepositoryId === repositoryId) {
    if (onboarding.selectedGithubRepositoryId !== repositoryId) {
      return { selectedGithubRepositoryId: repositoryId };
    }
    return null;
  }

  const dependentSteps = new Set<WorkspaceOnboardingStep>(REPOSITORY_SELECTION_DEPENDENT_STEPS);

  return {
    completedSteps: onboarding.completedSteps.filter((step) => !dependentSteps.has(step)),
    selectedGithubRepositoryId: repositoryId,
    skippedSteps: onboarding.skippedSteps.filter((step) => !dependentSteps.has(step)),
    status: "in_progress",
  };
}

export function buildOnboardingAdvancePatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload | null {
  const currentIndex = onboardingStepIndex(onboarding.currentStep);
  const nextStep = WORKSPACE_ONBOARDING_STEPS[currentIndex + 1];

  if (!nextStep) {
    return null;
  }

  return {
    currentStep: nextStep,
    status: "in_progress",
  };
}

export function buildOnboardingSkipPatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload | null {
  if (!canSkipOnboardingStep(onboarding.currentStep)) {
    return null;
  }

  const currentIndex = onboardingStepIndex(onboarding.currentStep);
  const nextStep = WORKSPACE_ONBOARDING_STEPS[currentIndex + 1];

  if (!nextStep) {
    return null;
  }

  return {
    completedSteps: removeStep(onboarding.completedSteps, onboarding.currentStep),
    currentStep: nextStep,
    skippedSteps: appendStep(onboarding.skippedSteps, onboarding.currentStep),
    status: "in_progress",
  };
}

export function buildOnboardingRailNavigationPatch(
  onboarding: WorkspaceOnboardingState,
  targetStep: WorkspaceOnboardingStep,
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.status === "completed") {
    return null;
  }

  if (targetStep === onboarding.currentStep) {
    return null;
  }

  return {
    currentStep: targetStep,
    status: "in_progress",
  };
}

export function buildOnboardingExitPatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.status === "completed") {
    return null;
  }

  return {
    status: "dismissed",
  };
}
