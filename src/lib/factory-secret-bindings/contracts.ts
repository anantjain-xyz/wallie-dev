import { z } from "zod";

import { AGENT_PROVIDERS, parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import { workspaceSecretKeySchema } from "@/lib/secrets/contracts";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const version = z.number().int().positive().safe();
const scope = z.object({
  grantId: uuid,
  agentId: uuid,
});
const openCodeProviderIdSchema = z
  .string()
  .max(100)
  .refine((id) => parseOpenCodeModelId(`${id}/model`)?.providerId === id);
const openCodeScope = scope.extend({
  provider: z.literal("opencode"),
  openCodeProviderId: openCodeProviderIdSchema,
});
const otherProviderScope = scope.extend({
  provider: z.enum(AGENT_PROVIDERS).exclude(["opencode"]),
});

const query = z.object({
  grantVersion: z.coerce.number().int().positive().safe(),
  bindingId: uuid.optional(),
});
export const factorySecretBindingQuerySchema = z.discriminatedUnion("provider", [
  openCodeScope.merge(query).strict(),
  otherProviderScope.merge(query).strict(),
]);

const attach = z.object({
  action: z.literal("attach"),
  grantVersion: version,
  workspaceSecretId: uuid,
});
export const factorySecretBindingCommandSchema = z.union([
  openCodeScope.merge(attach).strict(),
  otherProviderScope.merge(attach).strict(),
  z.object({ action: z.literal("revoke"), bindingId: uuid, expectedVersion: version }).strict(),
]);

const status = z.enum(["ready", "missing", "revoked", "grant_unavailable"]);
export const factorySecretBindingMetadataSchema = z.object({
  id: uuid,
  version,
  status,
  materialRevision: version.nullable(),
  rotatedAt: z.string().datetime({ offset: true }).nullable(),
  secretKey: workspaceSecretKeySchema.nullable(),
  openCodeProviderId: openCodeProviderIdSchema.optional(),
});

export const factorySecretBindingResponseSchema = z.object({
  binding: factorySecretBindingMetadataSchema.nullable(),
  availableBinding: factorySecretBindingMetadataSchema.nullable(),
  grantMatches: z.boolean(),
  eligibleSecrets: z.array(z.object({ id: uuid, key: workspaceSecretKeySchema })),
});

export const factorySecretBindingMutationResponseSchema = z.object({ id: uuid, version });

export type FactorySecretBindingScope = z.output<typeof factorySecretBindingQuerySchema>;
export type FactorySecretBindingCommand = z.output<typeof factorySecretBindingCommandSchema>;
export type FactorySecretBindingMetadata = z.output<typeof factorySecretBindingMetadataSchema>;
export type FactorySecretBindingResponse = z.output<typeof factorySecretBindingResponseSchema>;
