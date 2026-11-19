import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const BATCH_SIZE = 500;
const MAX_BATCHES = 8;

export async function pruneFactoryCommandAdmissions(admin: AdminClient) {
  let admissionsDeleted = 0;
  let leasesDeleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { data, error } = await admin
      .rpc("prune_factory_command_admissions", { p_batch_size: BATCH_SIZE })
      .single();
    if (error || !data) throw new Error("Could not prune expired factory command admissions.");
    admissionsDeleted += data.admissions_deleted;
    leasesDeleted += data.leases_deleted;
    if (data.admissions_deleted < BATCH_SIZE && data.leases_deleted < BATCH_SIZE) break;
  }
  return { admissionsDeleted, leasesDeleted };
}
