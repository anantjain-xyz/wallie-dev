import { z } from "zod";

import { agentConfigValueSchemas } from "@/lib/agent-config/contracts";
import {
  pipelineApproversSchema,
  pipelineOperatingRulesSchema,
  pipelineStageFields,
} from "@/lib/pipeline/stage-schema";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import { isFactoryDefinitionText } from "./serialization";

export const FACTORY_DEFINITION_SCHEMA_VERSION = 1;
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
    sandboxProvider: sandboxProviderSchema,
    agent: agentSchema,
    executionPolicy: optionalReferenceSchema,
    deliveryPolicy: optionalReferenceSchema,
    skills: z.array(referenceSchema).default([]),
    tools: z.array(referenceSchema).default([]),
    operatingRulesMd: pipelineOperatingRulesSchema
      .default("")
      .refine(isFactoryDefinitionText, validText),
    stages: z.array(stageSchema).min(1, "Add at least one stage to the serial workflow."),
  })
  .strict();

export type SerialFactoryDefinitionInput = z.input<typeof serialFactoryDefinitionSchema>;
export type SerialFactoryDefinition = z.output<typeof serialFactoryDefinitionSchema>;
