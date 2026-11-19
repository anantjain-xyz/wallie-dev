import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function pruneFactoryEventOutbox(admin: ReturnType<typeof createSupabaseAdminClient>) {
  const { error } = await admin
    .rpc("prune_factory_event_outbox", { p_batch_size: 500 })
    .abortSignal(AbortSignal.timeout(4_000))
    .single();
  if (error) throw new Error("Could not prune completed factory event deliveries.");
}
