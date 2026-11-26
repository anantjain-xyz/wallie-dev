import { z } from "zod";

import {
  modelRoutingConfigurationSchema,
  type ModelRoutingConfiguration,
  type ModelRoutingPolicy,
} from "@/lib/model-routing/contracts";

import { FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION, type SerialFactoryDefinition } from "./schema";

export const referenceKind = z.enum([
  "pipeline",
  "executionPolicy",
  "deliveryPolicy",
  "implementationAgent",
  "approvers",
  "skills",
  "scorers",
  "tools",
  "bindings",
  "grants",
  "context",
  "routing",
]);
export type ReferenceKind = z.infer<typeof referenceKind>;
const recentReferenceKinds = new Set<ReferenceKind>([
  "executionPolicy",
  "deliveryPolicy",
  "implementationAgent",
  "skills",
  "scorers",
  "tools",
  "bindings",
  "context",
  "routing",
]);
export function referenceSortsByRecency(kind: ReferenceKind) {
  return recentReferenceKinds.has(kind);
}
const uuid = z.string().uuid().toLowerCase();
const suggestionCursorSchema = z.strictObject({
  id: uuid,
  createdAt: z.string().max(40).datetime({ offset: true }).optional(),
});
export type SuggestionCursor = z.infer<typeof suggestionCursorSchema>;
const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  unavailable: z.boolean().optional(),
  labelOnly: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  pipelineId: uuid.optional(),
  agentId: uuid.optional(),
  grantId: uuid.optional(),
  version: z.number().int().positive().optional(),
  operations: z.array(z.string()).optional(),
  authKind: z.enum(["none", "bearer"]).optional(),
  toolId: uuid.optional(),
  principalId: uuid.optional(),
  toolIds: z.array(z.string()).optional(),
  sourceId: uuid.optional(),
  configuration: modelRoutingConfigurationSchema.optional(),
});
export type NamedReference = z.infer<typeof optionSchema>;
export const namedReferencesResponseSchema = z.object({
  groups: z.record(
    referenceKind,
    z.object({
      options: z.array(optionSchema),
      next: suggestionCursorSchema.optional(),
    }),
  ),
});
export const namedReferencePinBatchSize = 1600;
export const namedReferencesRequestSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("initial") }),
    z.strictObject({
      mode: z.literal("more"),
      kind: referenceKind,
      after: suggestionCursorSchema,
    }),
    z.strictObject({
      mode: z.literal("pins"),
      ids: z.record(referenceKind, z.array(uuid).max(namedReferencePinBatchSize)),
    }),
  ])
  .superRefine((request, context) => {
    if (
      request.mode === "more" &&
      referenceSortsByRecency(request.kind) !== (request.after.createdAt !== undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after", "createdAt"],
        message: "The cursor must match the suggestion order.",
      });
  });
export type NamedReferencesRequest = z.infer<typeof namedReferencesRequestSchema>;

export function routingConfigurations(policy: ModelRoutingPolicy | undefined) {
  if (!policy) return [];
  return [
    ...policy.rules.flatMap(({ configuration, onUnavailable }) =>
      onUnavailable.kind === "fallback"
        ? [configuration, onUnavailable.configuration]
        : [configuration],
    ),
    ...(policy.onUnmatched.kind === "fallback" ? [policy.onUnmatched.configuration] : []),
  ];
}

export function routingConfigurationKey(configuration: ModelRoutingConfiguration) {
  const {
    agentId,
    definitionRevisionId,
    experimentId,
    qualificationId,
    scorerRevisionId,
    modelKey,
    harness,
    workerRuntime,
  } = configuration;
  return [
    agentId,
    definitionRevisionId,
    experimentId,
    qualificationId,
    scorerRevisionId ?? "",
    modelKey,
    harness,
    workerRuntime,
  ].join(":");
}

export function grantReferenceKey(id: string, version: number) {
  return `${id}:${version}`;
}

export function definitionReferencePins(
  sources: readonly (SerialFactoryDefinition | undefined)[],
  proposedContextRevisionId?: string,
) {
  const ids: Partial<Record<ReferenceKind, string[]>> = {};
  function add(kind: ReferenceKind, ...values: (string | null | undefined)[]) {
    const valid = values.flatMap((value) => {
      const parsed = uuid.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    if (valid.length) ids[kind] = [...new Set([...(ids[kind] ?? []), ...valid])].sort();
  }
  add("context", proposedContextRevisionId);
  for (const source of sources) {
    if (!source) continue;
    add("pipeline", source.pipeline);
    add("executionPolicy", source.executionPolicy);
    add("deliveryPolicy", source.deliveryPolicy);
    add("implementationAgent", source.implementationAgent);
    add("skills", ...source.skills);
    if (source.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION)
      add("scorers", ...source.scorerRevisionIds);
    add("approvers", ...source.stages.flatMap(({ approverMemberIds }) => approverMemberIds));
    add("grants", source.executionGrant?.id);
    add("tools", ...(source.mcpBindings?.map(({ toolRevisionId }) => toolRevisionId) ?? []));
    add("bindings", ...(source.mcpBindings?.map(({ secretBindingId }) => secretBindingId) ?? []));
    add("context", ...(source.contextDocuments?.map(({ revisionId }) => revisionId) ?? []));
    add(
      "routing",
      ...routingConfigurations(source.modelRouting).map(({ experimentId }) => experimentId),
    );
  }
  return ids;
}
