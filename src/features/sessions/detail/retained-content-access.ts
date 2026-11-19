import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

export async function canManageSessionRetainedContent(
  supabase: SupabaseClient<Database>,
  scope: { workspaceId: string; factoryId: string },
  member: Pick<Tables<"workspace_members">, "id" | "role">,
) {
  if (member.role === "owner" || member.role === "admin") return true;
  const { data, error } = await supabase
    .from("factory_members")
    .select("role")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("member_id", member.id)
    .is("revoked_at", null)
    .maybeSingle();
  return !error && data?.role === "manager";
}
