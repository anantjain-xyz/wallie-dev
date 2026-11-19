import { z } from "zod";

export const FACTORY_MEMORY_CONTEXT_LIMIT = 8;
export const FACTORY_MEMORY_BODY_BYTES = 4_096;

export const memoryBodySchema = z
  .string()
  .min(1)
  .max(FACTORY_MEMORY_BODY_BYTES)
  .refine(
    (body) =>
      !body.includes("\0") && new TextEncoder().encode(body).length <= FACTORY_MEMORY_BODY_BYTES,
  );

export const factoryMemoryContextRowSchema = z.strictObject({
  memory_id: z.string().uuid(),
  revision_id: z.string().uuid(),
  approval_id: z.string().uuid(),
  body_md: memoryBodySchema,
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type FactoryMemoryContextRow = z.infer<typeof factoryMemoryContextRowSchema>;

const uuid = z.string().uuid();
const expected = {
  memoryId: uuid,
  expectedCurrentRevisionId: uuid.nullable(),
  expectedPendingRevisionId: uuid.nullable(),
};
const expiresAt = z.string().datetime({ offset: true }).optional();

export const factoryMemoryCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("propose"),
    artifactId: uuid,
    artifactVersion: z.number().int().min(1).max(2_147_483_647),
    title: z.string().trim().min(1).max(120),
    expiresAt,
  }),
  z.strictObject({
    action: z.literal("correct"),
    ...expected,
    body: memoryBodySchema.refine((body) => body.trim().length > 0),
    expiresAt,
  }),
  z.strictObject({
    action: z.literal("review"),
    ...expected,
    decision: z.enum(["approve", "reject"]),
  }),
  z.strictObject({ action: z.literal("forget"), ...expected }),
]);

const pageSize = z.coerce.number().int().min(1).max(50).default(20);
export const factoryMemoryPageSchema = z.union([
  z.strictObject({ afterId: uuid.optional(), limit: pageSize }),
  z.strictObject({
    memoryId: uuid,
    beforeVersion: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
    limit: pageSize,
  }),
  z.strictObject({
    artifactId: uuid,
    artifactVersion: z.coerce.number().int().min(1).max(2_147_483_647),
  }),
]);
