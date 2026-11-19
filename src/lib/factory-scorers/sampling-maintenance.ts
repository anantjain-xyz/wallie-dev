import "server-only";

import { z } from "zod/v4";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

const observationLimit = 25;
const count = z.number().int().nonnegative();
const sampleBatch = z
  .object({
    candidate_count: count,
    eligible_count: count,
    sampled_count: count,
    excluded_count: count,
  })
  .refine(
    (batch) =>
      batch.candidate_count === batch.eligible_count + batch.excluded_count &&
      batch.sampled_count <= batch.eligible_count,
  );

export async function processFactoryScorerSampling(
  admin: Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">,
) {
  const { data, error } = await admin
    .rpc("process_factory_scorer_sampling", { p_limit: observationLimit })
    .abortSignal(AbortSignal.timeout(15_000))
    .single();
  const result = sampleBatch.safeParse(data);
  if (error || !result.success) throw new Error("Could not process factory scorer sampling.");
  return result.data;
}
