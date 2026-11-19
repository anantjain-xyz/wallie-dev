import { z } from "zod";

import { agentConfigValueSchemas } from "@/lib/agent-config/contracts";
import { contextDocumentReferencesSchema } from "@/lib/factory-context/contracts";
import { MAX_FACTORY_SKILL_REVISIONS } from "@/lib/factory-skills/contracts";
import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import {
  factoryMcpManifestSchema,
  MAX_MCP_BINDINGS,
  MAX_MCP_OPERATIONS,
  mcpBindingSourceSchema,
  mcpManifestScopeIds,
} from "@/lib/factory-mcp/manifest";
import {
  pipelineApproversSchema,
  pipelineOperatingRulesSchema,
  pipelineStageFields,
} from "@/lib/pipeline/stage-schema";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import { isFactoryDefinitionText } from "./text";

export const FACTORY_DEFINITION_SCHEMA_VERSION = 1;
export const FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION = 2;
export const MAX_FACTORY_SCORER_REVISIONS = 32;
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
const executionGrantSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    version: z.number().int().positive().safe(),
  })
  .strict();
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

const serialDefinitionFields = z
  .object({
    kind: z.literal("serial", {
      errorMap: () => ({
        message: "Use a serial definition. Other workflow kinds are unavailable.",
      }),
    }),
    pipeline: referenceSchema,
    repository: referenceSchema,
    writableRepositories: z.array(referenceSchema).optional(),
    readContextRepositories: z.array(referenceSchema).optional(),
    contextDocuments: contextDocumentReferencesSchema.optional(),
    sandboxProvider: sandboxProviderSchema,
    agent: agentSchema,
    implementationAgent: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    executionPolicy: optionalReferenceSchema,
    executionGrant: executionGrantSchema.optional(),
    credentialBindingId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    deliveryPolicy: optionalReferenceSchema,
    skills: z.array(referenceSchema).max(MAX_FACTORY_SKILL_REVISIONS).default([]),
    tools: z.array(referenceSchema).default([]),
    mcpBindings: z.array(mcpBindingSourceSchema).max(MAX_MCP_BINDINGS).optional(),
    operatingRulesMd: pipelineOperatingRulesSchema
      .default("")
      .refine(isFactoryDefinitionText, validText),
    stages: z.array(stageSchema).min(1, "Add at least one stage to the serial workflow."),
  })
  .strict();

const stableUuid = z.string().uuid();
const scorerRevisionIdsSchema = z
  .array(stableUuid.transform((id) => id.toLowerCase()))
  .max(MAX_FACTORY_SCORER_REVISIONS)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Use each scorer revision only once.",
        });
      }
      seen.add(id);
    });
  });

export const serialFactoryDefinitionSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    serialDefinitionFields.extend({ schemaVersion: z.literal(FACTORY_DEFINITION_SCHEMA_VERSION) }),
    serialDefinitionFields.extend({
      schemaVersion: z.literal(FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION),
      scorerRevisionIds: scorerRevisionIdsSchema,
    }),
  ],
  {
    errorMap: (issue, context) => ({
      message:
        issue.code === "invalid_union_discriminator"
          ? "Use factory definition schema version 1 or 2."
          : context.defaultError,
    }),
  },
);

export type SerialFactoryDefinitionInput = z.input<typeof serialFactoryDefinitionSchema>;
export type SerialFactoryDefinition = z.output<typeof serialFactoryDefinitionSchema>;

const compiledDefinitionFields = serialDefinitionFields
  .omit({
    pipeline: true,
    repository: true,
    writableRepositories: true,
    readContextRepositories: true,
    executionPolicy: true,
    deliveryPolicy: true,
    skills: true,
    tools: true,
    mcpBindings: true,
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
    toolIds: z.array(referenceSchema).max(MAX_MCP_OPERATIONS),
    mcpManifest: factoryMcpManifestSchema.optional(),
    operatingRuleStageIds: z.array(stableUuid),
    stages: z.array(stageSchema.extend({ previousStageIds: z.array(stableUuid) })).min(1),
  });

export const compiledFactoryDefinitionSchema = z
  .discriminatedUnion("schemaVersion", [
    compiledDefinitionFields.extend({
      schemaVersion: z.literal(FACTORY_DEFINITION_SCHEMA_VERSION),
    }),
    compiledDefinitionFields.extend({
      schemaVersion: z.literal(FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION),
      scorerRevisionIds: z
        .array(stableUuid)
        .max(MAX_FACTORY_SCORER_REVISIONS)
        .refine(
          (ids) =>
            ids.every(
              (id, index) => id === id.toLowerCase() && (index === 0 || ids[index - 1] < id),
            ),
          "Use unique lowercase scorer revision IDs in ascending order.",
        ),
    }),
  ])
  .superRefine(
    (
      {
        executionGrant,
        credentialBindingId,
        implementationAgent,
        executionPolicyRevisionId,
        repositoryId,
        writableRepositoryIds,
        readContextRepositoryIds,
        contextDocuments,
        mcpManifest,
        toolIds,
      },
      context,
    ) => {
      if (executionGrant && (!executionPolicyRevisionId || writableRepositoryIds?.length)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionGrant"],
          message:
            "A service execution grant requires one writable repository and an execution policy revision.",
        });
      }
      if (contextDocuments && !executionGrant) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contextDocuments"],
          message: "Context documents require an approved service execution grant.",
        });
      }
      if (credentialBindingId && (!executionGrant || !implementationAgent)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["credentialBindingId"],
          message:
            "A credential binding requires a service execution grant and an implementation agent revision.",
        });
      }
      if (
        mcpManifest &&
        (!executionGrant || mcpManifest.agentId !== implementationAgent?.agentId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcpManifest"],
          message: "MCP bindings must use the pinned implementation agent and execution grant.",
        });
      }
      const scopes = mcpManifestScopeIds(mcpManifest?.servers ?? []);
      if (
        toolIds.length !== scopes.length ||
        toolIds.some((scope, index) => scope !== scopes[index])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toolIds"],
          message: "MCP operation scopes must match the pinned manifest.",
        });
      }
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
    },
  );

export type CompiledFactoryDefinition = z.output<typeof compiledFactoryDefinitionSchema>;
