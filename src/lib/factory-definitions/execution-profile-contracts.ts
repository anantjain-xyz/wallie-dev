import { z } from "zod";

import { AGENT_EFFORT_LEVELS, AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

const uuid = z.string().uuid();
const grantVersion = z.number().int().safe().positive();
const profileFields = z.object({
  provider: z.enum(AGENT_PROVIDERS),
  model: z.string().min(1),
  effort: z.enum(AGENT_EFFORT_LEVELS).nullable(),
  maxTurns: z.number().int().positive().nullable(),
});
const readiness = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string() }).strict(),
]);

export const factoryEditorExecutionProfileResponseSchema = z
  .object({
    profile: profileFields
      .extend({
        sandboxProvider: sandboxProviderSchema,
        credentialAuthority: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("human"), memberId: uuid.nullable() }).strict(),
          z
            .object({
              kind: z.literal("service"),
              grantId: uuid,
              grantVersion,
              bindingId: uuid.nullable(),
            })
            .strict(),
        ]),
      })
      .strict(),
    readiness: z.discriminatedUnion("status", [
      z.object({ status: z.literal("unavailable"), reason: z.string() }).strict(),
      z
        .object({ status: z.literal("checked"), credential: readiness, sandbox: readiness })
        .strict(),
    ]),
  })
  .strict();

export type FactoryEditorExecutionProfileResponse = z.infer<
  typeof factoryEditorExecutionProfileResponseSchema
>;

export const recordedRunExecutionProfileSchema = profileFields
  .extend({
    sandboxProvider: sandboxProviderSchema.nullable(),
    sandboxConnectionRevision: uuid.nullable(),
    workerRuntime: z.enum(["node", "workerd"]),
    definitionRevisionId: uuid.nullable(),
    factoryId: uuid,
    agentId: uuid.nullable(),
    promptRevisionId: uuid.nullable(),
    invokingMemberId: uuid.nullable(),
    triggeredByMemberId: uuid.nullable(),
    authority: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("human"), memberId: uuid }).strict(),
      z
        .object({
          kind: z.literal("service"),
          grantId: uuid,
          grantVersion,
          bindingId: uuid,
          servicePrincipalId: uuid,
        })
        .strict(),
      z.object({ kind: z.literal("unavailable") }).strict(),
    ]),
  })
  .strict();

export type RecordedRunExecutionProfile = z.infer<typeof recordedRunExecutionProfileSchema>;
