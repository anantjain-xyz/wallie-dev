import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

/**
 * Historical authorship does not authorize ongoing use of personal credentials.
 * Only an active human member of the session's workspace can supply them.
 */
export async function resolveSessionOwnerUserId(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id" | "workspace_id">,
): Promise<string | null> {
  if (!session.creator_member_id) return null;
  const { data, error } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("id", session.creator_member_id)
    .eq("workspace_id", session.workspace_id)
    .eq("is_active", true)
    .eq("kind", "human")
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}
