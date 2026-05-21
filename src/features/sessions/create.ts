import { z } from "zod";

import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";

export const createSessionPayloadSchema = z.object({
  githubRepositoryId: z.string().uuid("Repository id is invalid.").nullable().optional(),
  linearIssueUrl: z.string().nullable().optional(),
  promptMd: z.string().trim().min(1, "Prompt is required."),
  title: z.string().nullable().optional(),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type CreateSessionPayload = z.infer<typeof createSessionPayloadSchema>;

export function extractLinearIssueId(url: string): string | null {
  const match = url.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match) {
    return null;
  }
  return match[1]!.toUpperCase();
}

export function normalizeCreateSessionPayload(payload: CreateSessionPayload) {
  const promptMd = payload.promptMd.trim();
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
