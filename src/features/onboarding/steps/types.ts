import type { ReactNode } from "react";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import type { RuntimeReadiness } from "@/features/onboarding/runtime-readiness";
import type { WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { FlashMessage } from "@/features/settings/settings-types";

export type OnboardingDataUpdate =
  | WorkspaceOnboardingData
  | ((currentData: WorkspaceOnboardingData) => WorkspaceOnboardingData);

export type OnboardingDataChange = (update: OnboardingDataUpdate) => void;

export type RuntimeCompletionState = {
  hasInvalidDrafts: boolean;
  hasUnsavedDrafts: boolean;
  readiness: RuntimeReadiness;
};

export type OnboardingStepDraftState = { dirty: boolean; pending: boolean };

export type OnboardingStepProps = {
  data: WorkspaceOnboardingData;
  initialNow?: string;
  isSaving: boolean;
  onCompleteStep: (action: string) => Promise<void>;
  onKeepPipeline?: () => void;
  onPipelineCompleted: (
    action: string,
    pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
  ) => Promise<void>;
  onDataChange: OnboardingDataChange;
  onRefresh: (action: string) => Promise<void>;
  onRepositoryOnboardingChange: (
    repositoryId: string,
    onboarding: RepositoryOnboardingState,
  ) => void;
  onRepositorySetupMessage: (message: FlashMessage) => void;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
  onDraftStateChange?: (state: OnboardingStepDraftState) => void;
  onVerificationPendingChange?: (pending: boolean) => void;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
  onSelectGithubRepository: (repository: WorkspaceGitHubRepository) => Promise<boolean>;
  verificationActions?: ReactNode;
};
