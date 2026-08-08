import { z } from "zod";

import { extractLinearIssueId } from "@/features/sessions/linear-issue-url";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";

export const createSessionPayloadSchema = z
  .object({
    githubRepositoryId: z.string().uuid("Repository id is invalid.").nullable().optional(),
    linearIssueUrl: z.string().nullable().optional(),
    promptMd: z.string().nullable().optional(),
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
    githubRepositoryId: payload.githubRepositoryId?.trim() || null,
    linearIssueId: linearIssueUrl ? extractLinearIssueId(linearIssueUrl) : null,
    linearIssueUrl,
    promptMd,
    title,
    workspaceId: payload.workspaceId,
  };
}
