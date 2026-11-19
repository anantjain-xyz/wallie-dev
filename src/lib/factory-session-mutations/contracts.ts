import { z } from "zod/v4";

import { factoryReadRoutes } from "@/lib/factory-read-api/contracts";
import { Constants, type Enums } from "@/lib/supabase/database.types";

const uuid = z.uuid();
const positiveDatabaseInt = z.number().int().positive().max(2_147_483_647);
const exactArtifact = {
  artifactId: uuid,
  artifactVersion: positiveDatabaseInt,
  reviewRevision: z.number().int().nonnegative(),
};
const session = factoryReadRoutes.session;

function boundedMutationText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine(
      (text) => text.isWellFormed() && !text.includes("\0") && Array.from(text).length <= maxLength,
    )
    .meta({ maxLength });
}

export const factoryMutationKeySchema = uuid;

export const factoryMutationRoutes = {
  create: {
    path: factoryReadRoutes.sessions.path,
    params: factoryReadRoutes.sessions.params,
    body: z.strictObject({
      title: boundedMutationText(200),
      prompt: boundedMutationText(20_000),
      agentId: uuid,
      repositoryId: uuid,
      draftSpecification: z.boolean().default(false),
    }),
    scope: "sessions:create",
  },
  follow_up: {
    path: `${session.path}/follow-ups`,
    params: session.params,
    body: z.strictObject({
      ...exactArtifact,
      stageId: uuid,
      feedback: boundedMutationText(4_000),
    }),
    scope: "sessions:follow-up",
  },
  answer_clarification: {
    path: `${session.path}/clarifications/{clarificationId}/answers`,
    params: session.params.extend({ clarificationId: uuid }),
    body: z.strictObject({ ...exactArtifact, answer: boundedMutationText(2_000) }),
    scope: "sessions:clarify",
  },
  cancel: {
    path: `${session.path}/cancel`,
    params: session.params,
    body: z.strictObject({ expectedRunId: uuid }),
    scope: "sessions:cancel",
  },
} satisfies Record<
  string,
  { path: string; params: z.ZodObject; body: z.ZodObject; scope: Enums<"factory_command_scope"> }
>;

export type FactoryMutationOperation = keyof typeof factoryMutationRoutes;

export const factoryMutationReceiptSchema = z.object({
  receiptId: uuid,
  sessionId: uuid,
  sessionNumber: positiveDatabaseInt,
  workspaceSlug: z.string().min(1),
  phaseStatus: z.enum(Constants.public.Enums.pipeline_phase_status),
  jobId: uuid.nullable().optional(),
  runId: uuid.nullable().optional(),
  jobIds: z.array(uuid).optional(),
  runIds: z.array(uuid).optional(),
  feedbackBatchId: uuid.nullable().optional(),
  clarificationId: uuid.nullable().optional(),
  executionExhausted: z.boolean().optional(),
  replayed: z.boolean(),
});

export const factoryMutationResponseSchema = factoryMutationReceiptSchema.extend({
  canonicalUrl: z.string().startsWith("/w/"),
  conversationUrl: z.string().startsWith("/api/v1/"),
});

export const factoryMutationErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "stale_intent",
  "idempotency_conflict",
  "clarification_required",
  "request_conflict",
  "already_admitted",
  "request_too_large",
  "unsupported_media_type",
  "unready",
  "rate_limited",
  "concurrency_limited",
  "unavailable",
]);

export const factoryMutationErrorSchema = z.object({
  code: factoryMutationErrorCodeSchema,
  error: z.string(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
