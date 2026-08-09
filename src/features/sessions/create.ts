import { z } from "zod";

import { extractLinearIssueId } from "@/features/sessions/linear-issue-url";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import { maxSessionAttachments } from "@/lib/storage/contracts";

const selectedStageIdsSchema = z
  .array(z.string().uuid("Stage id is invalid."))
  .min(1, "Select at least one stage.")
  .refine((ids) => new Set(ids).size === ids.length, "Selected stages must be unique.");

const attachmentIdsSchema = z
  .array(z.string().uuid("Attachment id is invalid."))
  .max(maxSessionAttachments, "A session may include at most five images.")
  .refine((ids) => new Set(ids).size === ids.length, "Session images must be unique.");

export const createSessionPayloadSchema = z
  .object({
    attachmentIds: attachmentIdsSchema.optional(),
    githubRepositoryId: z.string().uuid("Repository id is invalid.").nullable().optional(),
    linearIssueUrl: z.string().nullable().optional(),
    promptMd: z.string().nullable().optional(),
    selectedStageIds: selectedStageIdsSchema.optional(),
    title: z.string().nullable().optional(),
    workspaceId: z.string().uuid("Workspace id is invalid."),
  })
  .superRefine((payload, context) => {
    const linearIssueUrl = payload.linearIssueUrl?.trim() ?? "";
    const promptMd = payload.promptMd?.trim() ?? "";

    if (!linearIssueUrl && !promptMd) {
      context.addIssue({
        code: "custom",
        message: "Enter a Linear issue URL or a prompt.",
        path: ["promptMd"],
      });
    }

    if (linearIssueUrl && !extractLinearIssueId(linearIssueUrl)) {
      context.addIssue({
        code: "custom",
        message: "Linear issue URL is invalid.",
        path: ["linearIssueUrl"],
      });
    }
  });

export type CreateSessionPayload = z.infer<typeof createSessionPayloadSchema>;

export function normalizeCreateSessionPayload(payload: CreateSessionPayload) {
  const promptMd = payload.promptMd?.trim() ?? "";
  const title = payload.title?.trim() || deriveSessionTitleFromPrompt(promptMd);
  const linearIssueUrl = payload.linearIssueUrl?.trim() || null;

  return {
    attachmentIds: payload.attachmentIds ?? [],
    githubRepositoryId: payload.githubRepositoryId?.trim() || null,
    linearIssueId: linearIssueUrl ? extractLinearIssueId(linearIssueUrl) : null,
    linearIssueUrl,
    promptMd,
    selectedStageIds: payload.selectedStageIds,
    title,
    workspaceId: payload.workspaceId,
  };
}
