import "server-only";

import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export async function loadWorkspaceSwitcherOptions(workspaceSlug: string) {
  const { supabase, user } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const { data, error } = await supabase
    .from("workspaces")
    .select("name, slug, membership:workspace_members!inner(id)")
    .eq("membership.user_id", user.id)
    .eq("membership.kind", "human")
    .eq("membership.is_active", true)
    .order("name")
    .order("slug");
  if (error) throw error;
  return data.map(({ name, slug }) => ({ name, slug }));
}
