import { z } from "zod";

export const githubWorkspaceQuerySchema = z.object({
  source: z.enum(["onboarding", "settings"]).optional(),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export const refreshGitHubRepositoriesSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type GitHubRepositorySummary = {
  defaultBranch: string | null;
  defaultProgrammingLanguage: string | null;
  description: string | null;
  fullName: string;
  htmlUrl: string;
  id: string;
  isArchived: boolean;
  isPrivate: boolean;
  name: string;
  repoId: number;
};

export type GitHubInstallationSummary = {
  appId: number;
  id: string;
  installationId: number;
  installationUrl: string;
  permissions: Record<string, unknown>;
  suspended: boolean;
  targetName: string;
  targetType: string;
  updatedAt: string;
};

export type GitHubAuthorIdentitySummary = {
  authorEmail: string;
  authorEmailSource: "github_noreply";
  authorEmailVerifiedAt: string | null;
  authorName: string;
  connectedAt: string;
  githubAvatarUrl: string | null;
  githubLogin: string;
  githubUserId: number;
  updatedAt: string;
  userId: string;
};

export type GitHubInstallResponse = {
  installUrl: string;
};

export type GitHubAuthorConnectResponse = {
  authorizeUrl: string;
};

export type GitHubRepositorySyncResponse = {
  installation: GitHubInstallationSummary;
  repositories: GitHubRepositorySummary[];
};
