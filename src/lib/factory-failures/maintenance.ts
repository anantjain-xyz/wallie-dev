import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function processFactoryFailureCohorts(
  admin: Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">,
) {
  const { error } = await admin
    .rpc("process_factory_failure_cohorts", { p_batch_size: 100 })
    .abortSignal(AbortSignal.timeout(15_000));
  if (error) throw new Error("Could not process factory failure cohorts.", { cause: error });
}
