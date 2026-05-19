import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

/**
 * Resolve the session owner's auth.uid so provider credentials can be loaded.
 * Sessions carry creator_member_id, which joins to workspace_members.user_id.
 */
export async function resolveSessionOwnerUserId(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<string | null> {
  if (!session.creator_member_id) return null;
  const { data, error } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("id", session.creator_member_id)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}
