import { z } from "zod";

export const ERASE_RETAINED_CONTENT_CONFIRMATION = "Erase retained content";

const timestamp = z.string().datetime({ offset: true });

export const eraseRetainedContentRequestSchema = z
  .object({
    expectedArchivedAt: timestamp,
    confirmation: z.literal(ERASE_RETAINED_CONTENT_CONFIRMATION),
  })
  .strict();

export const retainedContentStateSchema = z.object({
  archivedAt: timestamp.nullable(),
  erasedAt: timestamp.nullable(),
  canErase: z.boolean(),
});

export type RetainedContentState = z.infer<typeof retainedContentStateSchema>;
