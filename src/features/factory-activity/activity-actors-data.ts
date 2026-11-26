import "server-only";

import type {
  ActivityActor,
  ActivityActorSearch,
} from "@/features/factory-activity/activity-query";
import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import type { Tables } from "@/lib/supabase/database.types";

const ACTOR_SEARCH_LIMIT = 20;
const visible = "seat.not.is.null,created.not.is.null,triggered.not.is.null";

type ActorScope = Pick<AuthenticatedWorkspaceContext, "supabase"> & {
  workspaceId: string;
  factory: string;
};

function scopedActors({ supabase, workspaceId, factory }: ActorScope) {
  const result = supabase
    .from("workspace_members")
    .select(
      "id,full_name,username,kind,seat:factory_members!factory_members_member_id_fkey(),created:sessions!sessions_creator_member_id_fkey(),triggered:agent_runs!agent_runs_triggered_by_member_id_fkey(session:sessions!agent_runs_session_id_fkey!inner())",
    )
    .eq("workspace_id", workspaceId)
    .eq("seat.workspace_id", workspaceId)
    .is("seat.revoked_at", null)
    .eq("created.workspace_id", workspaceId)
    .eq("triggered.workspace_id", workspaceId)
    .eq("triggered.session.workspace_id", workspaceId)
    .limit(1, { referencedTable: "seat" })
    .limit(1, { referencedTable: "created" })
    .limit(1, { referencedTable: "triggered" });
  if (factory !== "all") {
    result.eq("seat.factory_id", factory);
    result.eq("created.factory_id", factory);
    result.eq("triggered.session.factory_id", factory);
  }
  return result;
}

export async function loadSelectedActivityActor(scope: ActorScope, id?: string) {
  if (!id) return null;
  const { data, error } = await scopedActors(scope).eq("id", id).or(visible).maybeSingle();
  return !error && data ? { id: data.id, label: optionLabel(data) ?? "Name unavailable" } : null;
}

export async function searchActivityActors(
  scope: ActorScope,
  term: string,
): Promise<ActivityActorSearch | null> {
  const query = scopedActors(scope).or(visible);
  if (term) {
    const pattern = JSON.stringify(`%${term.replace(/[\\%_*]/g, "\\$&")}%`);
    const system = "system".includes(term.toLowerCase()) ? ",kind.eq.system" : "";
    query.or(`full_name.ilike.${pattern},username.ilike.${pattern}${system}`);
  }
  const { data, error } = await query
    .or("full_name.not.is.null,username.not.is.null,kind.eq.system")
    .order("full_name", { nullsFirst: false })
    .order("username", { nullsFirst: false })
    .order("id")
    .limit(ACTOR_SEARCH_LIMIT + 1);
  if (error) return null;
  const actors = data.slice(0, ACTOR_SEARCH_LIMIT).flatMap((row): ActivityActor[] => {
    const label = optionLabel(row);
    return label ? [{ id: row.id, label }] : [];
  });
  return { actors, hasMore: data.length > ACTOR_SEARCH_LIMIT };
}

function optionLabel({
  full_name,
  username,
  kind,
}: Pick<Tables<"workspace_members">, "full_name" | "username" | "kind">) {
  const name = full_name?.trim();
  const handle = username?.trim();
  if (name) return handle ? `${name} (@${handle})` : `${name} (${kind})`;
  if (handle) return `@${handle} (${kind})`;
  return kind === "system" ? "System" : null;
}
