import { z } from "zod/v4";

const uuid = z.uuid().toLowerCase();
const provider = z.enum(["github", "linear"]);
const revision = z.number().int().nonnegative().safe();
const generation = revision.positive();
const externalId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{Cc}]+$/u);
const label = z.string().min(1).max(256);
const option = z.strictObject({ id: externalId, label });

export const connectorCatalogQuerySchema = z.union([
  z.strictObject({
    provider: z.literal("github"),
    kind: z.literal("repository").default("repository"),
    cursor: uuid.optional(),
  }),
  z.strictObject({
    provider: z.literal("github"),
    kind: z.literal("label"),
    resourceId: uuid,
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,7}$/)
      .transform(Number)
      .optional(),
  }),
  z.strictObject({
    provider: z.literal("linear"),
    kind: z.enum(["team", "project"]),
    cursor: cursor.optional(),
  }),
]);

export const connectorCatalogResponseSchema = z.strictObject({
  provider,
  kind: z.enum(["repository", "label", "team", "project"]),
  tenant: option,
  resources: z.array(option.extend({ externalId: externalId.optional() })),
  nextCursor: cursor.nullable(),
});

export const connectorSetupCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("connect"),
    provider,
    expectedTenantId: externalId,
    expectedGeneration: revision,
  }),
  z.strictObject({
    action: z.literal("map"),
    installationId: uuid,
    expectedGeneration: generation,
    expectedMappingRevision: revision,
    resource: z.strictObject({ kind: z.enum(["repository", "team", "project"]), id: uuid }),
  }),
  z.strictObject({
    action: z.literal("disable"),
    resourceId: uuid,
    expectedGeneration: generation,
    expectedMappingRevision: generation,
  }),
  z.strictObject({
    action: z.literal("disconnect"),
    installationId: uuid,
    expectedGeneration: generation,
  }),
  z.strictObject({
    action: z.literal("github_request"),
    resourceId: uuid,
    sourceKind: z.enum(["issue", "pull_request"]),
    expectedRevision: revision,
    labelId: generation,
    labelName: label.regex(/^[^\p{Cc}]+$/u),
  }),
]);

export const connectorSetupResponseSchema = z.union([
  z.strictObject({ installationId: uuid, generation }),
  z.strictObject({ resourceId: uuid, mappingRevision: generation }),
  z.strictObject({ disconnected: z.literal(true) }),
  z.strictObject({ revision: generation }),
]);

export type ConnectorCatalogResponse = z.output<typeof connectorCatalogResponseSchema>;
export type ConnectorSetupCommand = z.output<typeof connectorSetupCommandSchema>;
export type ConnectorSetupResponse = z.output<typeof connectorSetupResponseSchema>;
