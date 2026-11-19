import { z } from "zod";

const uuid = z.string().uuid();
const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const contextFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => {
    const parts = path.split("/");
    return (
      path === path.trim() &&
      !/[\p{Cc}\p{Cs}\\]/u.test(path) &&
      new TextEncoder().encode(path).byteLength <= 512 &&
      parts.length <= 12 &&
      parts.every((part) => part !== "" && part !== "." && part !== "..") &&
      /\.(md|markdown|txt)$/i.test(path)
    );
  });

export const contextSourceCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("register"),
    repositoryId: uuid,
    grantId: uuid,
    grantVersion: safeId,
    filePath: contextFilePathSchema,
  }),
  z.strictObject({
    action: z.literal("sync"),
    sourceId: uuid,
  }),
  z.strictObject({
    action: z.literal("remove"),
    sourceId: uuid,
  }),
]);

export const contextSourcePageSchema = z.strictObject({
  afterId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const contextSourceSyncClaimSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("syncing"),
    lease_id: uuid,
    installation_id: safeId,
    repository_id: safeId,
    repository_full_name: z.string().min(1),
    file_path: contextFilePathSchema,
  }),
  z.object({ status: z.literal("access_revoked") }),
  z.object({ status: z.literal("deleted") }),
]);

const canonicalContextId = uuid.transform((value) => value.toLowerCase());

export const contextDocumentReferenceSchema = z.strictObject({
  sourceId: canonicalContextId,
  revisionId: canonicalContextId,
});

export const contextDocumentReferencesSchema = z
  .array(contextDocumentReferenceSchema)
  .min(1)
  .max(8)
  .refine((refs) => new Set(refs.map(({ sourceId }) => sourceId)).size === refs.length, {
    message: "Select only one exact revision for each context source.",
  });

export type ContextDocumentReference = z.infer<typeof contextDocumentReferenceSchema>;
