import { z } from "zod";

import type { AgentConfigKey } from "@/lib/agent-config/contracts";
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
    skippedSteps: z.array(workspaceOnboardingStepSchema).optional(),
    status: workspaceOnboardingStatusSchema.optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one onboarding field is required.",
  });

export type WorkspaceOnboardingStep = z.infer<typeof workspaceOnboardingStepSchema>;
export type WorkspaceOnboardingStatus = z.infer<typeof workspaceOnboardingStatusSchema>;
export type WorkspaceOnboardingUpdatePayload = z.infer<
  typeof workspaceOnboardingUpdatePayloadSchema
>;

export type WorkspaceOnboardingState = {
  completedAt: string | null;
  completedSteps: WorkspaceOnboardingStep[];
  createdAt: string;
  currentStep: WorkspaceOnboardingStep;
  dismissedAt: string | null;
  id: string;
  skippedSteps: WorkspaceOnboardingStep[];
  status: WorkspaceOnboardingStatus;
  updatedAt: string;
  workspaceId: string;
};

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
    connected: boolean;
    expiresAt: string | null;
    status: "connected" | "expired" | "missing";
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
    anthropicApiKeyConfigured: boolean;
    configuredKeys: string[];
  };
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
