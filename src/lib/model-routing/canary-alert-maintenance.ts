import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

const batchSize = 8;
const resultSchema = z
  .strictObject({
    evaluated: z.number().int().min(0).max(batchSize),
    created: z
      .number()
      .int()
      .min(0)
      .max(batchSize * 3),
  })
  .refine(({ evaluated, created }) => created <= evaluated * 3);

export async function processFactoryRoutingCanaryAlerts(
  admin: Pick<SupabaseClient<Database>, "rpc">,
) {
  const { data, error } = await admin
    .rpc("process_factory_routing_canary_alerts", { p_limit: batchSize })
    .abortSignal(AbortSignal.timeout(15_000));
  const result = resultSchema.safeParse(data);
  if (error || !result.success) throw new Error("Could not evaluate routing canary degradation.");
  return result.data;
}
