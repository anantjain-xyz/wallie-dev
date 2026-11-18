import { z } from "zod";

const uuid = z.string().uuid();
const expectedVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function isFactoryExecutionAuthorityJsonRequest(request: Request) {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

export const createServicePrincipalSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const grantScope = z.strictObject({
  servicePrincipalId: uuid,
  writableRepositoryId: uuid,
  readContextRepositoryIds: z.array(uuid).max(50),
  toolIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/)).max(32),
  executionPolicyRevisionId: uuid,
  budgetPayerMemberId: uuid,
  expiresAt: z.string().datetime({ offset: true }),
});

export const factoryExecutionGrantCommandSchema = z.discriminatedUnion("action", [
  grantScope.extend({ action: z.literal("approve") }),
  grantScope.extend({ action: z.literal("update"), grantId: uuid, expectedVersion }),
  z.strictObject({
    action: z.literal("revoke"),
    grantId: uuid,
    expectedVersion,
    reason: z
      .string()
      .trim()
      .refine((value) => !/\p{Cc}/u.test(value) && new TextEncoder().encode(value).length <= 400)
      .optional(),
  }),
]);

export const factoryExecutionAuthorityPageSchema = z.strictObject({
  afterId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
