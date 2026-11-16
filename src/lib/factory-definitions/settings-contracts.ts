import { z } from "zod";

import { agentConfigValueSchemas as config } from "@/lib/agent-config/contracts";
import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import {
  pipelineApproversSchema,
  pipelineOperatingRulesSchema,
  pipelineStageFields,
} from "@/lib/pipeline/stage-schema";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

const uuid = z.string().uuid();
const pipelineName = z.string().trim().min(1).max(80);
const activationNumber = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const identity = z.object({ id: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) });

const stage = z.object({
  ...pipelineStageFields,
  anyoneCanApprove: z.boolean(),
  approverMemberIds: pipelineApproversSchema,
});
const displayedStage = stage.extend({ id: uuid, pipelineId: uuid, position: z.number().int() });
export const archivedFactoryStageSchema = displayedStage.extend({ archivedAt: z.string() });

export const factorySettingsAgentSchema = z.object({
  provider: config.agent_provider,
  model: config.agent_model,
  effort: config.agent_effort.nullable(),
  concurrencyLimit: config.concurrency_limit,
  stallTimeoutMs: config.stall_timeout_ms,
  maxRetries: config.max_retries,
  maxTurns: config.max_turns,
});

const patch = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pipeline"),
    name: pipelineName,
    operatingRulesMd: pipelineOperatingRulesSchema,
    stages: stage.extend({ id: uuid.nullish() }).array().min(1),
  }),
  z.object({ kind: z.literal("agent"), agent: factorySettingsAgentSchema }),
  z.object({ kind: z.literal("sandbox-provider"), provider: sandboxProviderSchema }),
  z.object({ kind: z.literal("execution-policy"), requirements: executionRequirementsSchema }),
  z.object({ kind: z.literal("delivery-policy"), requirements: deliveryRequirementsSchema }),
]);

export const factorySettingsCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    expectedActivationNumber: activationNumber,
    expectedDraftId: uuid.nullable(),
    patch,
  }),
  z.object({
    action: z.literal("publish"),
    expectedActivationNumber: activationNumber,
    draftId: uuid,
  }),
]);

export const factorySettingsSnapshotSchema = z.object({
  activationNumber,
  published: identity.nullable(),
  draft: identity.nullable(),
  publishedStages: displayedStage.pick({ id: true, name: true, slug: true }).array(),
  repositoryId: uuid,
  pipeline: z.object({
    id: uuid,
    isDefault: z.boolean(),
    name: pipelineName,
    operatingRulesMd: pipelineOperatingRulesSchema,
    stages: displayedStage.array(),
    archivedStages: archivedFactoryStageSchema.array(),
  }),
  agent: factorySettingsAgentSchema,
  sandboxProvider: sandboxProviderSchema,
  executionPolicy: executionRequirementsSchema.nullable(),
  deliveryPolicy: deliveryRequirementsSchema.nullable(),
});

export const factorySettingsResponseSchema = z.object({
  snapshot: factorySettingsSnapshotSchema.nullable(),
});

export type FactorySettingsSnapshot = z.infer<typeof factorySettingsSnapshotSchema>;
export type FactorySettingsPatch = z.infer<typeof patch>;
export type FactorySettingsCommand = z.infer<typeof factorySettingsCommandSchema>;
