import "server-only";

import { z } from "zod/v4";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Admin = Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">;

const batchSize = 25;
const projectionBatch = z.object({
  processed: z.number().int().min(0).max(batchSize),
  hasMore: z.boolean(),
});
const exportPruningLimit = 100;
const prunedExportCount = z.number().int().min(0).max(exportPruningLimit);

export async function processFactoryFlowProjection(admin: Admin) {
  const { data, error } = await admin
    .rpc("process_factory_flow_projection", { p_limit: batchSize })
    .abortSignal(AbortSignal.timeout(15_000));
  const result = projectionBatch.safeParse(data);
  if (error || !result.success) throw new Error("Could not process factory flow projections.");
  return result.data;
}

export async function pruneFactoryAnalyticsExports(admin: Admin) {
  const { data, error } = await admin
    .rpc("prune_factory_analytics_exports", { p_limit: exportPruningLimit })
    .abortSignal(AbortSignal.timeout(15_000));
  const count = prunedExportCount.safeParse(data);
  if (error || !count.success)
    throw new Error("Could not prune expired factory analytics exports.");
  return count.data;
}
