import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { routingCanarySummarySchema } from "./canary-contracts";

export async function loadFactoryRoutingCanary(
  client: Pick<SupabaseClient<Database>, "from">,
  {
    workspaceId,
    factoryId,
    activationNumber,
  }: {
    workspaceId: string;
    factoryId: string;
    activationNumber: number;
  },
) {
  const { data, error } = await client
    .from("factory_routing_canaries")
    .select(
      "id, task_class_id, task_class_slug, candidate_bps, activation_number, baseline_activation_number, candidate_revision_id, baseline_revision_id, minimum_support, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("activation_number", activationNumber)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return routingCanarySummarySchema.parse({
    id: data.id,
    taskClassId: data.task_class_id,
    taskClassSlug: data.task_class_slug,
    candidateBps: data.candidate_bps,
    activationNumber: data.activation_number,
    baselineActivationNumber: data.baseline_activation_number,
    candidateRevisionId: data.candidate_revision_id,
    baselineRevisionId: data.baseline_revision_id,
    minimumSupport: data.minimum_support,
    createdAt: data.created_at,
  });
}
