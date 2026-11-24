import { z } from "zod/v4";

const uuid = z.uuid().toLowerCase();
const revision = z.number().int().safe().nonnegative();

export const linearDiscoveryConfigSchema = z.strictObject({
  revision,
  mappingRevision: revision.positive(),
  enabled: z.boolean(),
  stateIds: z.array(uuid).max(20),
  labelId: uuid.nullable(),
  serviceActorId: uuid.nullable(),
});

export const configureLinearDiscoverySchema = linearDiscoveryConfigSchema
  .omit({ revision: true })
  .extend({
    expectedRevision: revision,
    stateIds: z.array(uuid).min(1).max(20),
    labelId: uuid.optional(),
    serviceActorId: uuid.optional(),
  });

const statusMapping = z
  .strictObject({
    teamId: uuid,
    fromStateId: uuid,
    toStateId: uuid,
  })
  .refine(({ fromStateId, toStateId }) => fromStateId !== toStateId);

export const linearOutboundConfigSchema = z.strictObject({
  revision,
  mappingRevision: revision.positive(),
  commentsEnabled: z.boolean(),
  statusMapping: statusMapping.nullable(),
});

export const configureLinearOutboundSchema = linearOutboundConfigSchema
  .omit({ revision: true })
  .extend({ expectedRevision: revision });

export const linearPolicyRevisionSchema = z.strictObject({ revision: revision.positive() });
