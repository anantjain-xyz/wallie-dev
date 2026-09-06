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
    description: "Choose which GitHub repositories Wallie can prepare and work on.",
    id: "github",
    shortTitle: "GitHub",
    title: "Connect GitHub",
  },
  {
    description: "Choose a repository, review its setup commands, and prepare it for your agent.",
    id: "repository",
    shortTitle: "Repository",
    title: "Prepare repository",
  },
  {
    description: "Start with Plan → Build, or customize the stages and reviewers for your team.",
    id: "pipeline",
    shortTitle: "Pipeline",
    title: "Review pipeline",
  },
  {
    description:
      "Optional: attach issue context and sync status updates. You can start with a prompt alone.",
    id: "linear",
    shortTitle: "Linear",
    title: "Connect Linear (optional)",
  },
  {
    description: "Choose and connect a sandbox provider for running agents.",
    id: "sandbox",
    shortTitle: "Sandbox",
    title: "Connect Sandbox",
  },
  {
    description: "Configure the coding agent provider and credentials.",
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

export const ONBOARDING_GROUPS: { title: string; steps: WorkspaceOnboardingStep[] }[] = [
  { title: "Repository", steps: ["github", "repository", "pipeline"] },
  { title: "Execution access", steps: ["linear", "sandbox", "runtime"] },
  { title: "First task", steps: ["verify"] },
];

export const SKIPPABLE_ONBOARDING_STEPS = ["linear", "runtime"] as const;

type OnboardingResumeRow = { current_step: string; status: string } | null;

export type OnboardingStepDisplayState =
  | "active"
  | "available"
  | "blocked"
  | "completed"
  | "skipped";

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
): OnboardingStepRailItem[] {
  const completed =
    onboarding.status === "completed"
      ? new Set<WorkspaceOnboardingStep>(WORKSPACE_ONBOARDING_STEPS)
      : new Set(onboarding.completedSteps);
  const skipped = new Set(onboarding.skippedSteps);

  return ONBOARDING_STEPS.map((step, index) => {
    let displayState: OnboardingStepDisplayState = "blocked";

    if (step.id === onboarding.currentStep) {
      displayState = "active";
    } else if (skipped.has(step.id)) {
      displayState = "skipped";
    } else if (completed.has(step.id)) {
      displayState = "completed";
    } else {
      displayState = "available";
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
