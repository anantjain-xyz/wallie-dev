import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/schema";
import type { Database } from "@/lib/supabase/database.types";

import { modelRoutingConfigurationSchema } from "./contracts";
import type { RoutingOverrideOptions } from "./operation-contracts";

const reviewedTargetsSchema = z.array(
  z.object({
    ruleId: z.string().uuid().nullable(),
    target: z.enum(["primary", "rule_fallback", "unmatched_fallback"]),
    configuration: modelRoutingConfigurationSchema,
  }),
);

export function selectReviewedFactoryRoutingActivation(
  client: Pick<SupabaseClient<Database>, "from">,
  scope: { workspaceId: string; factoryId: string; activationNumber: number },
) {
  return client
    .from("factory_routing_activations")
    .select("reviewed_targets")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("activation_number", scope.activationNumber)
    .maybeSingle();
}

export function buildRoutingOverrideOptions({
  definition,
  activationNumber,
  reviewedTargets,
}: {
  definition: Pick<CompiledFactoryDefinition, "stages" | "modelRouting">;
  activationNumber: number;
  reviewedTargets: unknown;
}): RoutingOverrideOptions | undefined {
  const policy = definition.modelRouting;
  if (!policy) return;

  const reviewed = reviewedTargetsSchema.parse(reviewedTargets);
  const classIds = new Map(policy.taskClasses.map(({ slug, id }) => [slug, id]));
  const rules = new Map(policy.rules.map((rule) => [rule.taskClassId, rule.id]));
  const targets: RoutingOverrideOptions["targets"] = [];
  for (const stage of definition.stages) {
    const classId = classIds.get(stage.slug);
    const ruleId = classId && rules.get(classId);
    if (!ruleId) continue;

    for (const item of reviewed) {
      if (item.ruleId !== ruleId || item.target === "unmatched_fallback") continue;
      const { modelKey, harness, workerRuntime } = item.configuration;
      targets.push({
        stageId: stage.id,
        ruleId,
        target: item.target,
        modelKey,
        harness,
        workerRuntime,
      });
    }
  }
  if (targets.length) return { activationNumber, targets };
}
