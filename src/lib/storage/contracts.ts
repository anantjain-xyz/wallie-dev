import { z } from "zod";

export const workspaceAvatarParamsSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type WorkspaceAvatarUploadResponse = {
  avatarPath: string;
  avatarUrl: string;
};
