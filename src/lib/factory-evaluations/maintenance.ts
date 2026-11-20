import "server-only";

import { z } from "zod/v4";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

const batchLimit = 25;
const count = z.number().int().min(0).max(batchLimit);
const maintenanceResult = z
  .object({
    receipts_processed: count,
    jobs_admitted: count,
    attempts_recovered: count,
    jobs_requeued: count,
    jobs_failed: count,
  })
  .refine(
    (batch) =>
      batch.jobs_admitted <= batch.receipts_processed &&
      batch.attempts_recovered === batch.jobs_requeued + batch.jobs_failed,
  );

export async function maintainFactoryEvaluationQueue(
  admin: Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">,
) {
  const { data, error } = await admin
    .rpc("maintain_factory_evaluation_queue", { p_limit: batchLimit })
    .abortSignal(AbortSignal.timeout(15_000))
    .single();
  const result = maintenanceResult.safeParse(data);
  if (error || !result.success) throw new Error("Could not maintain the factory evaluation queue.");
  return result.data;
}
