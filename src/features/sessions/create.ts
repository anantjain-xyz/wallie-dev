import { z } from "zod";

import { extractLinearIssueId } from "@/features/sessions/linear-issue-url";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import { workflowIntakeSelectionSchema } from "@/lib/factory-workflows/intake-selection";
import { routingOverrideSchema } from "@/lib/model-routing/operation-contracts";
import { maxSessionAttachments } from "@/lib/storage/contracts";

const selectedStageIdsSchema = z
  .array(z.string().uuid("Stage id is invalid."))
  .min(1, "Select at least one stage.")
  .refine((ids) => new Set(ids).size === ids.length, "Selected stages must be unique.");

const attachmentIdsSchema = z
  .array(z.string().uuid("Attachment id is invalid."))
  .max(maxSessionAttachments, "A session may include at most five images.")
  .refine((ids) => new Set(ids).size === ids.length, "Session images must be unique.");

const browserWorkflowSelectionSchema = z.unknown().transform((value, context) => {
  const parsed = workflowIntakeSelectionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({ code: "custom", message: "Select an exact published workflow activation." });
  return z.NEVER;
});

export const createSessionPayloadSchema = z
  .object({
    attachmentIds: attachmentIdsSchema.optional(),
    draftSpecification: z.boolean().optional(),
    factoryDefinitionDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "Factory definition digest is invalid.")
      .optional(),
    factoryId: z.string().uuid("Factory id is invalid.").optional(),
    githubRepositoryId: z.string().uuid("Repository id is invalid.").nullable().optional(),
    linearIssueUrl: z.string().nullable().optional(),
    promptMd: z.string().nullable().optional(),
    requestId: z.string().uuid("Creation request id is invalid.").optional(),
    restartOfSessionId: z.string().uuid("Source session id is invalid.").optional(),
    routingOverride: routingOverrideSchema.optional(),
    selectedStageIds: selectedStageIdsSchema.optional(),
    title: z.string().nullable().optional(),
    workflowSelection: browserWorkflowSelectionSchema.optional(),
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

    if (
      (payload.restartOfSessionId ||
        payload.factoryDefinitionDigest ||
        payload.factoryId ||
        payload.routingOverride) &&
      !payload.requestId
    ) {
      context.addIssue({
        code: "custom",
        message: payload.restartOfSessionId
          ? "A creation request id is required to restart a session."
          : payload.factoryId
            ? "A creation request id is required to start a factory session."
            : "A creation request id is required to confirm a factory definition.",
        path: ["requestId"],
      });
    }

    if (
      payload.workflowSelection &&
      (!payload.requestId ||
        !payload.factoryDefinitionDigest ||
        payload.restartOfSessionId ||
        payload.routingOverride ||
        payload.draftSpecification)
    ) {
      context.addIssue({
        code: "custom",
        message: "Confirm a new factory session to select a published workflow.",
        path: ["workflowSelection"],
      });
    }

    if (
      payload.routingOverride &&
      (!payload.factoryDefinitionDigest || payload.restartOfSessionId || payload.draftSpecification)
    ) {
      context.addIssue({
        code: "custom",
        message: "Confirm a factory definition to override routing for a new pipeline session.",
        path: ["routingOverride"],
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
    ...(payload.draftSpecification ? { draftSpecification: true } : {}),
    ...(payload.factoryDefinitionDigest
      ? { factoryDefinitionDigest: payload.factoryDefinitionDigest }
      : {}),
    ...(payload.factoryId ? { factoryId: payload.factoryId.toLowerCase() } : {}),
    githubRepositoryId: payload.githubRepositoryId?.trim() || null,
    linearIssueId: linearIssueUrl ? extractLinearIssueId(linearIssueUrl) : null,
    linearIssueUrl,
    promptMd,
    requestId: payload.requestId,
    ...(payload.restartOfSessionId
      ? { restartOfSessionId: payload.restartOfSessionId.toLowerCase() }
      : {}),
    ...(payload.routingOverride
      ? {
          routingOverride: {
            expectedActivationNumber: payload.routingOverride.expectedActivationNumber,
            ruleId: payload.routingOverride.ruleId.toLowerCase(),
            target: payload.routingOverride.target,
            reason: payload.routingOverride.reason.trim(),
          },
        }
      : {}),
    selectedStageIds: payload.selectedStageIds,
    title,
    ...(payload.workflowSelection
      ? { workflowSelection: workflowIntakeSelectionSchema.parse(payload.workflowSelection) }
      : {}),
    workspaceId: payload.workspaceId,
  };
}
