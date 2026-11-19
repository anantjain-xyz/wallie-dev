import { z } from "zod/v4";

import { Constants } from "@/lib/supabase/database.types";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const stageSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const relativeLink = z.string().startsWith("/w/");
const bodyHtml = z.string();

const scopeParams = z.strictObject({ workspaceId: uuid, factoryId: uuid });
const sessionParams = scopeParams.extend({ sessionId: uuid });
const noQuery = z.strictObject({});
export const factoryReadCursorTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const pageQuery = z.strictObject({
  cursor: factoryReadCursorTokenSchema.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .optional(),
});

export const factoryReadReviewRecordSchema = z.object({
  stageId: uuid,
  stageSlug,
  artifactId: uuid,
  artifactVersion: positiveInteger,
  reviewRevision: z.number().int().nonnegative(),
  runId: uuid,
  attemptCount: positiveInteger,
  checkpointRunId: uuid,
  clarification: z.object({ id: uuid, question: z.string() }).nullable(),
});

export const factoryReadSessionRecordSchema = z.object({
  id: uuid,
  number: positiveInteger,
  title: z.string(),
  status: z.enum(Constants.public.Enums.pipeline_phase_status),
  archivedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  currentStageId: uuid.nullable(),
  currentRunId: uuid.nullable(),
  specificationStageId: uuid.nullable(),
  review: factoryReadReviewRecordSchema.nullable(),
});

const sessionResponse = factoryReadSessionRecordSchema.extend({
  canonicalUrl: relativeLink,
  review: factoryReadReviewRecordSchema.extend({ href: relativeLink }).nullable(),
});

export const factoryReadRunRecordSchema = z.object({
  id: uuid,
  sessionId: uuid,
  sessionNumber: positiveInteger,
  stageId: uuid.nullable(),
  stageName: z.string().nullable(),
  stageSlug: stageSlug.nullable(),
  status: z.enum(Constants.public.Enums.agent_run_status),
  attemptCount: positiveInteger.nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  artifactId: uuid.nullable(),
  artifactCoverage: z.enum(["available", "unavailable"]),
  transcriptAvailability: z.enum(["expired", "not_exposed"]),
});

const runResponse = factoryReadRunRecordSchema.extend({ canonicalUrl: relativeLink });

export const factoryReadSourceRecordSchema = z.object({
  id: uuid,
  provider: z.string(),
  label: z.string().nullable(),
  url: z.string().nullable(),
});

const sourceResponse = factoryReadSourceRecordSchema.extend({ url: z.url().nullable() });

export const factoryReadMessageRecordSchema = z.object({
  sequence: positiveInteger,
  kind: z.enum(Constants.public.Enums.session_conversation_message_kind),
  authorKind: z.enum(Constants.public.Enums.session_conversation_author_kind),
  authorLabel: z.string(),
  createdAt: timestamp,
  bodyMarkdown: z.string(),
  bodyTruncated: z.boolean(),
  runId: uuid.nullable(),
  attemptCount: positiveInteger.nullable(),
  artifactId: uuid.nullable(),
  source: factoryReadSourceRecordSchema.nullable(),
});

const messageResponse = factoryReadMessageRecordSchema.omit({ bodyMarkdown: true }).extend({
  bodyHtml,
  source: sourceResponse.nullable(),
});

export const factoryReadArtifactRecordSchema = z.object({
  id: uuid,
  sessionId: uuid,
  sessionNumber: positiveInteger,
  stageId: uuid,
  stageSlug,
  version: positiveInteger,
  createdAt: timestamp,
  bodyMarkdown: z.string(),
  provenance: z.object({
    runId: uuid,
    attemptCount: positiveInteger,
    checkpointRunId: uuid,
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
});

const artifactResponse = factoryReadArtifactRecordSchema.omit({ bodyMarkdown: true }).extend({
  canonicalUrl: relativeLink,
  bodyHtml,
  href: relativeLink,
});

const cursorResponse = factoryReadCursorTokenSchema.nullable();
const path = "/api/v1/workspaces/{workspaceId}/factories/{factoryId}";

export const factoryReadRoutes = {
  sessions: {
    path: `${path}/sessions`,
    params: scopeParams,
    query: pageQuery,
    response: z.object({ items: z.array(sessionResponse), nextCursor: cursorResponse }),
  },
  session: {
    path: `${path}/sessions/{sessionId}`,
    params: sessionParams,
    query: noQuery,
    response: sessionResponse,
  },
  conversation: {
    path: `${path}/sessions/{sessionId}/conversation`,
    params: sessionParams,
    query: pageQuery.extend({ direction: z.enum(["before", "after"]).optional() }),
    response: z.object({
      canonicalUrl: relativeLink,
      items: z.array(messageResponse),
      sources: z.array(sourceResponse),
      nextCursor: cursorResponse,
      resumeCursor: factoryReadCursorTokenSchema,
    }),
  },
  runs: {
    path: `${path}/runs`,
    params: scopeParams,
    query: pageQuery.extend({ sessionId: uuid.optional() }),
    response: z.object({ items: z.array(runResponse), nextCursor: cursorResponse }),
  },
  run: {
    path: `${path}/runs/{runId}`,
    params: scopeParams.extend({ runId: uuid }),
    query: noQuery,
    response: runResponse,
  },
  artifact: {
    path: `${path}/sessions/{sessionId}/artifacts/{artifactId}`,
    params: sessionParams.extend({ artifactId: uuid }),
    query: noQuery,
    response: artifactResponse,
  },
};

const factoryReadErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_cursor",
  "unauthorized",
  "forbidden",
  "not_found",
  "resource_unavailable",
  "unavailable",
  "request_conflict",
  "already_admitted",
  "rate_limited",
  "concurrency_limited",
]);

export const factoryReadErrorSchema = z.object({
  code: factoryReadErrorCodeSchema,
  error: z.string(),
  retryAfterSeconds: positiveInteger.optional(),
});

export type FactoryReadOperation = keyof typeof factoryReadRoutes;
export type FactoryReadErrorCode = z.infer<typeof factoryReadErrorCodeSchema>;
