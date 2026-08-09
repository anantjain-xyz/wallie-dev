import { z } from "zod";

export const maxSessionAttachmentBytes = 4 * 1024 * 1024;
export const maxSessionAttachments = 5;
export const allowedSessionAttachmentMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type SessionAttachmentMimeType = (typeof allowedSessionAttachmentMimeTypes)[number];

export const workspaceAvatarParamsSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type WorkspaceAvatarUploadResponse = {
  avatarPath: string;
  avatarUrl: string;
};

export const sessionAttachmentWorkspaceParamsSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export const sessionAttachmentParamsSchema = sessionAttachmentWorkspaceParamsSchema.extend({
  attachmentId: z.string().uuid("Attachment id is invalid."),
});

export const sessionAttachmentReadParamsSchema = z.object({
  attachmentId: z.string().uuid("Attachment id is invalid."),
  sessionId: z.string().uuid("Session id is invalid."),
});

export type SessionAttachmentUploadResponse = {
  contentType: SessionAttachmentMimeType;
  fileName: string;
  id: string;
  sizeBytes: number;
};
