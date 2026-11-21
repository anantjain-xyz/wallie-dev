import { z } from "zod";

import { AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

const id = z.string().uuid().toLowerCase();
const taskClassId = id.brand<"RoutingTaskClassId">();
const ruleId = id.brand<"ModelRoutingRuleId">();
const basisPoints = z.number().int().min(0).max(10_000);
const maxEntries = 100;

export const modelRoutingConfigurationSchema = z.strictObject({
  agentId: id,
  definitionRevisionId: id,
  experimentId: id,
  qualificationId: id,
  scorerRevisionId: id.optional(),
  modelKey: z
    .string()
    .max(200)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[1m\])?$/,
      "Use the provider and model ID from the qualification receipt.",
    ),
  harness: z.enum(AGENT_PROVIDERS),
  workerRuntime: z.enum(["node", "workerd"]),
});

const modelRoutingConstraintsSchema = z.strictObject({
  qualityFloorBps: basisPoints,
  maxMeanCostUsd: z.number().finite().min(0).max(1_000_000).nullable(),
  maxLatencyMs: z.number().int().min(1).max(86_400_000).nullable(),
  minResolvedTrials: z.number().int().min(2).max(10_000),
  minConfidenceBps: basisPoints.nullable(),
});

const escalate = z.strictObject({ kind: z.literal("escalate") });
const fallback = z.strictObject({
  kind: z.literal("fallback"),
  configuration: modelRoutingConfigurationSchema,
});

const taskClass = z.strictObject({
  id: taskClassId,
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(120).refine(isFactoryDefinitionText),
});

const rule = z.strictObject({
  id: ruleId,
  taskClassId,
  configuration: modelRoutingConfigurationSchema,
  constraints: modelRoutingConstraintsSchema,
  onUnavailable: z.discriminatedUnion("kind", [escalate, fallback]),
});

export type ModelRoutingConfiguration = z.infer<typeof modelRoutingConfigurationSchema>;

function sameConfiguration(
  primary: ModelRoutingConfiguration,
  alternative: ModelRoutingConfiguration,
): boolean {
  return (
    primary.agentId === alternative.agentId &&
    primary.definitionRevisionId === alternative.definitionRevisionId &&
    primary.modelKey === alternative.modelKey &&
    primary.harness === alternative.harness &&
    primary.workerRuntime === alternative.workerRuntime
  );
}

export const modelRoutingPolicySchema = z
  .strictObject({
    version: z.literal(1),
    taskClasses: z.array(taskClass).max(maxEntries),
    rules: z.array(rule).max(maxEntries),
    onUnmatched: z.discriminatedUnion("kind", [
      escalate,
      fallback.extend({ constraints: modelRoutingConstraintsSchema }),
    ]),
  })
  .superRefine((policy, context) => {
    const classIds = new Set<z.infer<typeof taskClassId>>();
    const classSlugs = new Set<string>();
    policy.taskClasses.forEach((entry, index) => {
      if (classIds.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskClasses", index, "id"],
          message: "Use each task class ID only once.",
        });
      }
      if (classSlugs.has(entry.slug)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskClasses", index, "slug"],
          message: "Use each task class slug only once.",
        });
      }
      classIds.add(entry.id);
      classSlugs.add(entry.slug);
    });

    const ruleIds = new Set<z.infer<typeof ruleId>>();
    const assignedClasses = new Set<z.infer<typeof taskClassId>>();
    policy.rules.forEach((entry, index) => {
      if (ruleIds.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "id"],
          message: "Use each rule ID only once.",
        });
      }
      if (!classIds.has(entry.taskClassId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "taskClassId"],
          message: "Choose a task class from this policy.",
        });
      } else if (assignedClasses.has(entry.taskClassId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "taskClassId"],
          message: "Assign at most one rule to each task class.",
        });
      }
      if (
        entry.onUnavailable.kind === "fallback" &&
        sameConfiguration(entry.configuration, entry.onUnavailable.configuration)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "onUnavailable", "configuration"],
          message: "Choose a fallback with a different execution configuration.",
        });
      }
      ruleIds.add(entry.id);
      assignedClasses.add(entry.taskClassId);
    });
  });

export type ModelRoutingPolicy = z.infer<typeof modelRoutingPolicySchema>;

export function modelRoutingTargets(policy: ModelRoutingPolicy): Array<{
  configuration: ModelRoutingConfiguration;
  path: Array<string | number>;
}> {
  const targets: ReturnType<typeof modelRoutingTargets> = [];
  policy.rules.forEach((entry, index) => {
    targets.push({ configuration: entry.configuration, path: ["rules", index, "configuration"] });
    if (entry.onUnavailable.kind === "fallback") {
      targets.push({
        configuration: entry.onUnavailable.configuration,
        path: ["rules", index, "onUnavailable", "configuration"],
      });
    }
  });
  if (policy.onUnmatched.kind === "fallback") {
    targets.push({
      configuration: policy.onUnmatched.configuration,
      path: ["onUnmatched", "configuration"],
    });
  }
  return targets;
}
