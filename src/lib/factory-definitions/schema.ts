import { z } from "zod";

import { agentConfigValueSchemas } from "@/lib/agent-config/contracts";
import { MAX_FACTORY_SKILL_REVISIONS } from "@/lib/factory-skills/contracts";
import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import {
  pipelineApproversSchema,
  pipelineOperatingRulesSchema,
  pipelineStageFields,
} from "@/lib/pipeline/stage-schema";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import { isFactoryDefinitionText } from "./text";

export const FACTORY_DEFINITION_SCHEMA_VERSION = 1;
export const factoryDefinitionExpectedActivationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const factoryDefinitionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("structured"), value: z.record(z.unknown()) }).strict(),
  z.object({ kind: z.literal("json"), text: z.string() }).strict(),
]);
const validText = { message: "Use well-formed Unicode text without NUL characters." };
const referenceSchema = z
  .string()
  .trim()
  .min(1, "Provide a component ID or alias.")
  .refine(isFactoryDefinitionText, validText);
const optionalReferenceSchema = referenceSchema
  .nullish()
  .transform((reference) => reference ?? null);
const agentSchema = z
  .object({
    provider: agentConfigValueSchemas.agent_provider,
    model: agentConfigValueSchemas.agent_model,
    effort: agentConfigValueSchemas.agent_effort.nullish().transform((effort) => effort ?? null),
    concurrencyLimit: agentConfigValueSchemas.concurrency_limit,
    stallTimeoutMs: agentConfigValueSchemas.stall_timeout_ms,
    maxRetries: agentConfigValueSchemas.max_retries.transform((retries) =>
      retries === 0 ? 0 : retries,
    ),
    maxTurns: agentConfigValueSchemas.max_turns,
  })
  .strict();

const stageSchema = z
  .object({
    ...pipelineStageFields,
    id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    name: pipelineStageFields.name.refine(isFactoryDefinitionText, validText),
    description: pipelineStageFields.description.refine(isFactoryDefinitionText, validText),
    promptTemplateMd: pipelineStageFields.promptTemplateMd.refine(
      isFactoryDefinitionText,
      validText,
    ),
    anyoneCanApprove: z.boolean().default(false),
    approverMemberIds: pipelineApproversSchema,
  })
  .strict();

export const serialFactoryDefinitionSchema = z
  .object({
    schemaVersion: z.literal(FACTORY_DEFINITION_SCHEMA_VERSION, {
      errorMap: () => ({ message: "Use factory definition schema version 1." }),
    }),
    kind: z.literal("serial", {
      errorMap: () => ({
        message: "Use a serial definition. Other workflow kinds are unavailable.",
      }),
    }),
    pipeline: referenceSchema,
    repository: referenceSchema,
    writableRepositories: z.array(referenceSchema).optional(),
    readContextRepositories: z.array(referenceSchema).optional(),
    sandboxProvider: sandboxProviderSchema,
    agent: agentSchema,
    implementationAgent: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    executionPolicy: optionalReferenceSchema,
    deliveryPolicy: optionalReferenceSchema,
    skills: z.array(referenceSchema).max(MAX_FACTORY_SKILL_REVISIONS).default([]),
    tools: z.array(referenceSchema).default([]),
    operatingRulesMd: pipelineOperatingRulesSchema
      .default("")
      .refine(isFactoryDefinitionText, validText),
    stages: z.array(stageSchema).min(1, "Add at least one stage to the serial workflow."),
  })
  .strict();

export type SerialFactoryDefinitionInput = z.input<typeof serialFactoryDefinitionSchema>;
export type SerialFactoryDefinition = z.output<typeof serialFactoryDefinitionSchema>;

const stableUuid = z.string().uuid();
export const compiledFactoryDefinitionSchema = serialFactoryDefinitionSchema
  .omit({
    pipeline: true,
    repository: true,
    writableRepositories: true,
    readContextRepositories: true,
    executionPolicy: true,
    deliveryPolicy: true,
    skills: true,
    tools: true,
    implementationAgent: true,
  })
  .extend({
    pipelineId: stableUuid,
    implementationAgent: factoryAgentPromptSnapshotSchema.optional(),
    repositoryId: stableUuid,
    writableRepositoryIds: z.array(stableUuid).min(1).optional(),
    readContextRepositoryIds: z.array(stableUuid).min(1).optional(),
    executionPolicyRevisionId: stableUuid.nullable(),
    deliveryPolicyRevisionId: stableUuid.nullable(),
    skillIds: z.array(referenceSchema).max(MAX_FACTORY_SKILL_REVISIONS),
    toolIds: z.array(referenceSchema),
    operatingRuleStageIds: z.array(stableUuid),
    stages: z.array(stageSchema.extend({ previousStageIds: z.array(stableUuid) })).min(1),
  })
  .superRefine(({ repositoryId, writableRepositoryIds, readContextRepositoryIds }, context) => {
    const seen = new Set([repositoryId.toLowerCase()]);
    for (const [field, ids] of [
      ["writableRepositoryIds", writableRepositoryIds ?? []],
      ["readContextRepositoryIds", readContextRepositoryIds ?? []],
    ] as const) {
      ids.forEach((id, index) => {
        const normalizedId = id.toLowerCase();
        if (seen.has(normalizedId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index],
            message: "Use each repository only once across the factory's repository bindings.",
          });
        }
        seen.add(normalizedId);
      });
    }
  });
