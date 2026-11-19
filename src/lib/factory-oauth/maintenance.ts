import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function pruneFactoryOAuthCredentials(admin: AdminClient) {
  const { data, error } = await admin
    .rpc("prune_factory_oauth_credentials", { p_batch_size: 200 })
    .single();
  if (error || !data) throw new Error("Could not prune expired OAuth credentials.");

  return {
    authorizationsDeleted: data.authorizations_deleted,
    tokenPairsDeleted: data.token_pairs_deleted,
  };
}
