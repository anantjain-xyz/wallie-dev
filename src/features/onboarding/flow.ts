import type {
  WorkspaceOnboardingState,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import { WORKSPACE_ONBOARDING_STEPS } from "@/lib/onboarding/contracts";

export type OnboardingStepDefinition = {
  description: string;
  id: WorkspaceOnboardingStep;
  shortTitle: string;
  title: string;
};

export const ONBOARDING_STEPS: OnboardingStepDefinition[] = [
  {
    description: "Confirm the GitHub App connection for this workspace.",
    id: "github",
    shortTitle: "GitHub",
    title: "Connect GitHub",
  },
  {
    description: "Choose the repository Wallie will prepare first.",
    id: "repository",
    shortTitle: "Repo",
    title: "Select repository",
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
    title: "Configure Linear",
  },
  {
    description: "Check coding-agent and sandbox runtime readiness.",
    id: "runtime",
    shortTitle: "Runtime",
    title: "Verify runtime",
  },
  {
    description: "Confirm the setup health signals before starting work.",
    id: "verify",
    shortTitle: "Verify",
    title: "Verify setup",
  },
];

export const SKIPPABLE_ONBOARDING_STEPS = ["linear", "runtime"] as const;

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

export type OnboardingResumeState = Pick<WorkspaceOnboardingState, "currentStep" | "status">;

const STEP_INDEX = new Map<WorkspaceOnboardingStep, number>(
  WORKSPACE_ONBOARDING_STEPS.map((step, index) => [step, index]),
);

export function onboardingStepIndex(step: WorkspaceOnboardingStep) {
  return STEP_INDEX.get(step) ?? 0;
}

export function shouldShowOnboardingResumeCta(onboarding: OnboardingResumeState | null) {
  return Boolean(onboarding && onboarding.status !== "completed");
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

export function getOnboardingStepRailItems(
  onboarding: WorkspaceOnboardingState,
): OnboardingStepRailItem[] {
  const activeIndex = onboardingStepIndex(onboarding.currentStep);
  const completed =
    onboarding.status === "completed"
      ? new Set<WorkspaceOnboardingStep>(WORKSPACE_ONBOARDING_STEPS)
      : new Set(onboarding.completedSteps);
  const skipped = new Set(onboarding.skippedSteps);

  return ONBOARDING_STEPS.map((step, index) => {
    let displayState: OnboardingStepDisplayState = "blocked";

    if (step.id === onboarding.currentStep) {
      displayState = "active";
    } else if (completed.has(step.id)) {
      displayState = "completed";
    } else if (skipped.has(step.id)) {
      displayState = "skipped";
    } else if (index < activeIndex) {
      displayState = "available";
    }

    return {
      ...step,
      displayState,
      isNavigable: displayState !== "blocked",
      position: index + 1,
    };
  });
}

export function buildOnboardingContinuePatch(
  onboarding: WorkspaceOnboardingState,
): WorkspaceOnboardingUpdatePayload {
  const currentIndex = onboardingStepIndex(onboarding.currentStep);
  const completedSteps = appendStep(onboarding.completedSteps, onboarding.currentStep);
  const nextStep = WORKSPACE_ONBOARDING_STEPS[currentIndex + 1];

  if (!nextStep) {
    return {
      completedSteps,
      currentStep: onboarding.currentStep,
      status: "completed",
    };
  }

  return {
    completedSteps,
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
    currentStep: nextStep,
    skippedSteps: appendStep(onboarding.skippedSteps, onboarding.currentStep),
    status: "in_progress",
  };
}

export function buildOnboardingRailNavigationPatch(
  onboarding: WorkspaceOnboardingState,
  targetStep: WorkspaceOnboardingStep,
): WorkspaceOnboardingUpdatePayload | null {
  const target = getOnboardingStepRailItems(onboarding).find((step) => step.id === targetStep);

  if (!target?.isNavigable || targetStep === onboarding.currentStep) {
    return null;
  }

  return {
    currentStep: targetStep,
    status: onboarding.status === "completed" ? "completed" : "in_progress",
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
