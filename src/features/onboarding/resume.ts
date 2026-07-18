import type { WorkspaceOnboardingState } from "@/lib/onboarding/contracts";

export type OnboardingResumeState = Pick<WorkspaceOnboardingState, "currentStep" | "status">;

export function shouldShowOnboardingResumeCta(onboarding: OnboardingResumeState | null) {
  return Boolean(onboarding && onboarding.status !== "completed");
}
