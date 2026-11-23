import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export async function expireFactoryDeliveryDispatches(admin: SupabaseClient<Database>) {
  const { error } = await admin
    .rpc("expire_factory_delivery_dispatches")
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error("Could not expire delivery dispatches.", { cause: error });
}
