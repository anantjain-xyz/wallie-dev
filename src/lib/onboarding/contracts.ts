import { z } from "zod";

import type { AgentConfigKey } from "@/lib/agent-config/contracts";
import type { CodexCredentialType } from "@/lib/codex/contracts";
import type { RepositoryOnboardingStatus } from "@/lib/repo-onboarding/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";

export const WORKSPACE_ONBOARDING_STEPS = [
  "github",
  "repository",
  "pipeline",
  "linear",
  "runtime",
  "verify",
] as const;

export const WORKSPACE_ONBOARDING_STATUSES = [
  "not_started",
  "in_progress",
  "dismissed",
  "completed",
] as const;

export const workspaceOnboardingStepSchema = z.enum(WORKSPACE_ONBOARDING_STEPS);
export const workspaceOnboardingStatusSchema = z.enum(WORKSPACE_ONBOARDING_STATUSES);

export const workspaceOnboardingUpdatePayloadSchema = z
  .object({
    completedSteps: z.array(workspaceOnboardingStepSchema).optional(),
    currentStep: workspaceOnboardingStepSchema.optional(),
    selectedGithubRepositoryId: z
      .string()
      .uuid("Selected repository id is invalid.")
      .nullable()
      .optional(),
    skippedSteps: z.array(workspaceOnboardingStepSchema).optional(),
    status: workspaceOnboardingStatusSchema.optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one onboarding field is required.",
  });

export const WORKSPACE_ONBOARDING_MUTATION_ACTIONS = [
  "continue",
  "exit",
  "navigate",
  "repository-selection",
  "skip",
  "step-complete",
] as const;

export const workspaceOnboardingMutationActionSchema = z.enum(
  WORKSPACE_ONBOARDING_MUTATION_ACTIONS,
);

export const workspaceOnboardingMutationRequestSchema = z.object({
  action: workspaceOnboardingMutationActionSchema,
  changes: workspaceOnboardingUpdatePayloadSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  step: workspaceOnboardingStepSchema,
});

export const workspaceOnboardingCompletionRequestSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export type WorkspaceOnboardingStep = z.infer<typeof workspaceOnboardingStepSchema>;
export type WorkspaceOnboardingStatus = z.infer<typeof workspaceOnboardingStatusSchema>;
export type WorkspaceOnboardingUpdatePayload = z.infer<
  typeof workspaceOnboardingUpdatePayloadSchema
>;
export type WorkspaceOnboardingMutationAction = z.infer<
  typeof workspaceOnboardingMutationActionSchema
>;
export type WorkspaceOnboardingMutationRequest = z.infer<
  typeof workspaceOnboardingMutationRequestSchema
>;

export type WorkspaceOnboardingState = {
  completedAt: string | null;
  completedSteps: WorkspaceOnboardingStep[];
  createdAt: string;
  currentStep: WorkspaceOnboardingStep;
  dismissedAt: string | null;
  id: string;
  selectedGithubRepositoryId: string | null;
  skippedSteps: WorkspaceOnboardingStep[];
  status: WorkspaceOnboardingStatus;
  updatedAt: string;
  workspaceId: string;
};

export type WorkspaceOnboardingStepState = Pick<
  WorkspaceOnboardingState,
  | "completedAt"
  | "completedSteps"
  | "currentStep"
  | "dismissedAt"
  | "selectedGithubRepositoryId"
  | "skippedSteps"
  | "status"
>;

export type SetupPresenceStatus = "missing" | "present";
export type SetupReadinessStatus = "missing" | "placeholder" | "ready";

export type OnboardingSetupHealth = {
  agentConfig: {
    configured: boolean;
    configuredKeys: AgentConfigKey[];
    status: SetupPresenceStatus;
    values: Partial<Record<AgentConfigKey, unknown>>;
  };
  codexConnection: {
    checkedAt: string;
    connected: boolean;
    credentialType: CodexCredentialType | null;
    expiresAt: string | null;
    status: "connected" | "expired" | "missing";
    updatedAt: string | null;
  };
  claudeCodeConnection: {
    checkedAt: string;
    connected: boolean;
    status: "connected" | "missing";
    updatedAt: string | null;
  };
  defaultPipeline: {
    configured: boolean;
    pipelineId: string | null;
    stageCount: number;
    status: Extract<SetupReadinessStatus, "missing" | "ready">;
  };
  githubInstallation: {
    connected: boolean;
    installationId: number | null;
    status: SetupPresenceStatus;
    suspended: boolean | null;
    targetName: string | null;
    updatedAt: string | null;
  };
  latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null;
  vercelSandboxConnection: {
    connected: boolean;
    lastValidationError: string | null;
    projectId: string | null;
    projectName: string | null;
    status: "connected" | "error" | "missing";
    teamId: string | null;
    updatedAt: string | null;
  };
  selectedRepository: {
    configured: boolean;
    fullName: string | null;
    repositoryId: string | null;
    status: Extract<SetupReadinessStatus, "missing" | "ready">;
  };
  linearKey: {
    configured: boolean;
    status: SetupPresenceStatus;
    updatedAt: string | null;
  };
  linearRouting: {
    configured: boolean;
    status: SetupPresenceStatus;
    updatedAt: string | null;
  };
  workspaceSecrets: {
    configuredKeys: string[];
  };
  // Temporary compatibility: saved repository profile readiness still mirrors legacy is_primary storage.
  primaryRepositoryProfile: {
    configured: boolean;
    fullName: string | null;
    repositoryId: string | null;
    status: Extract<SetupReadinessStatus, "missing" | "ready">;
  };
  repositorySetup: {
    configured: boolean;
    repositoryId: string | null;
    status: RepositoryOnboardingStatus | Extract<SetupReadinessStatus, "placeholder">;
  };
};

export type OnboardingSetupHealthDelta = Partial<OnboardingSetupHealth>;

export type OnboardingValidationError = {
  field: string;
  message: string;
};

export type WorkspaceOnboardingMutationDelta = {
  action: WorkspaceOnboardingMutationAction | "complete";
  kind: "onboarding-mutation";
  onboarding: WorkspaceOnboardingStepState;
  setupHealth: OnboardingSetupHealthDelta;
  step: WorkspaceOnboardingStep;
  updatedAt: string;
  validationErrors: OnboardingValidationError[];
};

export type WorkspaceOnboardingConflictResponse = {
  action: WorkspaceOnboardingMutationAction | "complete";
  authoritative: {
    onboarding: WorkspaceOnboardingStepState;
    setupHealth: OnboardingSetupHealthDelta;
    updatedAt: string;
  };
  error: string;
  kind: "onboarding-conflict";
  retryable: true;
  step: WorkspaceOnboardingStep;
  validationErrors: OnboardingValidationError[];
};

export type WorkspaceOnboardingMutationErrorResponse = {
  action: WorkspaceOnboardingMutationAction | "complete" | null;
  error: string;
  kind: "onboarding-mutation-error";
  retryable: boolean;
  step: WorkspaceOnboardingStep | null;
  validationErrors: OnboardingValidationError[];
};
