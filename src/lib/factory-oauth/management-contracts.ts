import { z } from "zod";

import { factoryCommandScopesSchema } from "@/lib/factory-machine-tokens/contracts";
import { factoryOAuthRedirectUriSchema } from "@/lib/factory-oauth/protocol";

const uuid = z.string().uuid().toLowerCase();

export const registerFactoryOAuthClientSchema = z.strictObject({
  action: z.literal("register"),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !/\p{Cc}/u.test(name)),
  redirectUris: z
    .array(factoryOAuthRedirectUriSchema)
    .min(1)
    .max(10)
    .refine((uris) => new Set(uris).size === uris.length),
  scopes: factoryCommandScopesSchema.refine((scopes) => scopes.length > 0),
  bindings: z
    .array(
      z.strictObject({
        factoryId: uuid,
        executionGrantId: uuid,
        executionGrantVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (bindings) => new Set(bindings.map(({ factoryId }) => factoryId)).size === bindings.length,
    ),
});

export const factoryOAuthManagementSchema = z.discriminatedUnion("action", [
  registerFactoryOAuthClientSchema,
  z.strictObject({ action: z.literal("revoke-client"), clientId: uuid }),
  z.strictObject({ action: z.literal("revoke-grant"), grantId: uuid }),
]);

export type FactoryOAuthManagementCommand = z.output<typeof factoryOAuthManagementSchema>;
