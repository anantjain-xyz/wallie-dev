import { z } from "zod";

import { factoryInboxKinds } from "./inbox-kinds";

const id = z.string().uuid();
const occurredAt = z.string().datetime({ offset: true });

export const factoryInboxKindSchema = z.enum(factoryInboxKinds);

const factoryInboxItemSchema = z
  .object({
    sessionId: id,
    sessionNumber: z.number().int().positive(),
    title: z.string(),
    factoryId: id,
    factoryName: z.string(),
    stageId: id,
    stageSlug: z.string(),
    stageName: z.string(),
    artifactId: id,
    artifactVersion: z.number().int().positive(),
    reviewRevision: z.number().int().nonnegative(),
    sourceLabel: z.string(),
    occurredAt,
    hasBlockingFeedback: z.boolean(),
  })
  .and(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("review"), clarificationId: z.null() }),
      z.object({ kind: z.literal("clarification"), clarificationId: id }),
    ]),
  );

export const factoryInboxQuerySchema = z.object({
  workspaceId: id,
  factoryId: id.optional(),
  kind: factoryInboxKindSchema.optional(),
  cursor: z.string().min(1).max(180).optional(),
});

export const factoryInboxCursorSchema = z.object({ occurredAt, artifactId: id });

const inboxSnapshotShape = {
  items: z.array(factoryInboxItemSchema).max(25),
  counts: z.object({
    review: z.number().int().nonnegative(),
    clarification: z.number().int().nonnegative(),
  }),
};

export const factoryInboxProjectionSchema = z.object({
  ...inboxSnapshotShape,
  next: factoryInboxCursorSchema.nullable(),
});

export const factoryInboxSchema = z.object({
  ...inboxSnapshotShape,
  nextCursor: z.string().nullable(),
});

export type FactoryInbox = z.infer<typeof factoryInboxSchema>;
export type FactoryInboxItem = z.infer<typeof factoryInboxItemSchema>;
export type FactoryInboxKind = z.infer<typeof factoryInboxKindSchema>;
