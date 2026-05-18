import { z } from "zod";

export const REPOSITORY_ONBOARDING_STATUSES = [
  "not_set_up",
  "pr_open",
  "ready",
  "conflict",
  "error",
] as const;

export type RepositoryOnboardingStatus = (typeof REPOSITORY_ONBOARDING_STATUSES)[number];

export type RepositoryOnboardingConflict = {
  path: string;
  reason: "existing_skill_differs" | "github_read_failed";
  message: string;
};

export type RepositoryOnboardingState = {
  conflictReport: RepositoryOnboardingConflict[];
  githubRepositoryId: string;
  installedSkillHash: string | null;
  installedSkillVersion: number | null;
  lastError: string | null;
  setupBranchName: string | null;
  setupPrNumber: number | null;
  setupPrUrl: string | null;
  status: RepositoryOnboardingStatus;
  updatedAt: string | null;
};

export type RepositoryOnboardingResponse = {
  onboarding: RepositoryOnboardingState;
};

export const repositoryOnboardingManualReadyPayloadSchema = z.object({
  action: z.literal("mark_ready"),
});

export type RepositoryOnboardingManualReadyPayload = z.infer<
  typeof repositoryOnboardingManualReadyPayloadSchema
>;

export const repositoryOnboardingParamsSchema = z.object({
  repositoryId: z.string().uuid("Repository id is invalid."),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});
