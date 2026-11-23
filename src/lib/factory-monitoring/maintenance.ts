import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export async function drainFactoryMonitoringIncidents(
  admin: Pick<SupabaseClient<Database>, "rpc">,
) {
  const signal = AbortSignal.timeout(8_000);
  for (let index = 0; index < 4 && !signal.aborted; index++) {
    const { data, error } = await admin
      .rpc("admit_next_factory_monitoring_incident")
      .abortSignal(signal);
    if (error) throw new Error("Could not admit monitoring incidents.", { cause: error });
    if (data === null) return;
  }
}
