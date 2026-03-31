import { z } from "zod";

export const workspaceSecretKeySchema = z
  .string()
  .trim()
  .min(1, "Secret key is required.")
  .max(120, "Secret keys must stay under 120 characters.")
  .regex(
    /^[A-Z0-9_]+$/,
    "Use uppercase letters, numbers, and underscores only for secret keys.",
  );

export const listWorkspaceSecretsQuerySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export const upsertWorkspaceSecretSchema = z.object({
  key: workspaceSecretKeySchema,
  value: z.string().min(1, "Secret value is required.").max(20000),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type WorkspaceSecretPreview = {
  createdAt: string;
  createdByMemberId: string | null;
  id: string;
  key: string;
  updatedAt: string;
  valuePreview: string | null;
  workspaceId: string;
};

export type ListWorkspaceSecretsResponse = {
  secrets: WorkspaceSecretPreview[];
};

export type UpsertWorkspaceSecretResponse = {
  secret: WorkspaceSecretPreview;
};

export type DeleteWorkspaceSecretResponse = {
  deletedKey: string;
};
