import { z } from "zod";

import { agentConfigValueSchemas } from "@/lib/agent-config/contracts";
import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import {
  pipelineApproversSchema,
  pipelineOperatingRulesSchema,
  pipelineStageFields,
} from "@/lib/pipeline/stage-schema";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

export const settingsPipelineStagePatchSchema = z
  .object({
    id: z.string().uuid().nullish(),
    ...pipelineStageFields,
    anyoneCanApprove: z.boolean().default(false),
    approverMemberIds: pipelineApproversSchema,
  })
  .strict();

export const settingsPipelinePatchSchema = z
  .object({
    kind: z.literal("pipeline"),
    name: z.string().trim().min(1, "Pipeline name is required.").max(80),
    operatingRulesMd: pipelineOperatingRulesSchema.default(""),
    stages: z.array(settingsPipelineStagePatchSchema).min(1, "Add at least one stage."),
  })
  .strict();

export const settingsAgentPatchSchema = z
  .object({
    kind: z.literal("agent"),
    agent: z
      .object({
        provider: agentConfigValueSchemas.agent_provider,
        model: agentConfigValueSchemas.agent_model,
        effort: agentConfigValueSchemas.agent_effort.nullish().transform((value) => value ?? null),
        concurrencyLimit: agentConfigValueSchemas.concurrency_limit,
        stallTimeoutMs: agentConfigValueSchemas.stall_timeout_ms,
        maxRetries: agentConfigValueSchemas.max_retries,
        maxTurns: agentConfigValueSchemas.max_turns,
      })
      .strict(),
  })
  .strict();

export const settingsExecutionPolicyPatchSchema = z
  .object({
    kind: z.literal("execution-policy"),
    expectedPolicyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requirements: executionRequirementsSchema,
  })
  .strict();

export const settingsDeliveryPolicyPatchSchema = z
  .object({
    kind: z.literal("delivery-policy"),
    pipelineId: z.string().uuid(),
    expectedPolicyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requirements: deliveryRequirementsSchema,
  })
  .strict();

export const settingsSandboxProviderPatchSchema = z
  .object({
    kind: z.literal("sandbox-provider"),
    sandboxProvider: sandboxProviderSchema,
  })
  .strict();

export const settingsFactoryPatchSchema = z.discriminatedUnion("kind", [
  settingsPipelinePatchSchema,
  settingsAgentPatchSchema,
  settingsExecutionPolicyPatchSchema,
  settingsDeliveryPolicyPatchSchema,
  settingsSandboxProviderPatchSchema,
]);

export const settingsFactoryCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("draft"),
      expectedActivationNumber: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - 1),
      expectedDraftId: z.string().uuid().nullable(),
      patch: settingsFactoryPatchSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      expectedActivationNumber: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - 1),
      draftId: z.string().uuid(),
    })
    .strict(),
]);
