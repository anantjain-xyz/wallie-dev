import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingConflictResponse,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingState,
} from "@/lib/onboarding/contracts";

type OnboardingMutationData = {
  onboarding: WorkspaceOnboardingState;
  setupHealth: OnboardingSetupHealth;
};

export function reduceOnboardingMutationData<T extends OnboardingMutationData>(
  currentData: T,
  response: WorkspaceOnboardingMutationDelta | WorkspaceOnboardingConflictResponse,
): T {
  const delta =
    response.kind === "onboarding-conflict"
      ? response.authoritative
      : {
          onboarding: response.onboarding,
          setupHealth: response.setupHealth,
          updatedAt: response.updatedAt,
        };
  const onboarding = {
    ...currentData.onboarding,
    ...delta.onboarding,
    updatedAt: delta.updatedAt,
  };
  const mutationKey = `${response.step}:${response.action}`;

  if (response.kind === "onboarding-conflict") {
    return {
      ...currentData,
      onboarding,
      setupHealth: { ...currentData.setupHealth, ...delta.setupHealth },
    };
  }

  switch (mutationKey) {
    case "repository:repository-selection":
      return {
        ...currentData,
        onboarding,
        setupHealth: { ...currentData.setupHealth, ...delta.setupHealth },
      };
    default:
      return { ...currentData, onboarding };
  }
}
