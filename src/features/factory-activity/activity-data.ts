import "server-only";

import {
  agentRunStatusValue,
  sessionPhaseStatusValue,
  type StatusValue,
} from "@/components/ui/status";
import { RUN_PROVIDER_LABELS } from "@/features/wallie/runs-list-state";
import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceRunDetailPath, workspaceSessionDetailPath } from "@/lib/routes";
import type { Tables } from "@/lib/supabase/database.types";

const ACTIVITY_PREVIEW_LIMIT = 10;

type ActivityFilters = { factoryId?: string; actorId?: string };

type ActivityContext = Pick<AuthenticatedWorkspaceContext, "supabase"> & {
  workspaceId: string;
  workspaceSlug: string;
  filters: ActivityFilters;
};

type Factory = Pick<Tables<"factories">, "id" | "name">;
type Member = Pick<Tables<"workspace_members">, "full_name" | "username" | "kind">;

export type ActivityActor = { id: string; label: string } | null;

export type ActivityRow = {
  id: string;
  href: string;
  title: string;
  description: string | null;
  occurredAt: string;
  factory: Factory;
  actor: ActivityActor;
  status: StatusValue;
};

export type ActivitySection =
  | { kind: "available"; count: number; rows: ActivityRow[] }
  | { kind: "unavailable" };

export async function loadFactoryActivityData(context: ActivityContext) {
  const [sessions, runs] = await Promise.all([loadSessions(context), loadRuns(context)]);
  return { sessions, runs, capturedAt: new Date().toISOString() };
}

export type FactoryActivityData = Awaited<ReturnType<typeof loadFactoryActivityData>>;

async function loadSessions({
  supabase,
  workspaceId,
  workspaceSlug,
  filters,
}: ActivityContext): Promise<ActivitySection> {
  const query = supabase
    .from("sessions")
    .select(
      "id,number,title,phase_status,archived_at,updated_at,creator_member_id,factory:factories!sessions_workspace_factory_fkey!inner(id,name),actor:workspace_members!sessions_creator_member_id_fkey(full_name,username,kind)",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .eq("actor.workspace_id", workspaceId);
  if (filters.factoryId) query.eq("factory_id", filters.factoryId);
  if (filters.actorId) query.eq("creator_member_id", filters.actorId);
  const { data, count, error } = await query
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACTIVITY_PREVIEW_LIMIT);
  if (error || !data || count === null) return { kind: "unavailable" };

  return {
    kind: "available",
    count,
    rows: data.map((row) => ({
      id: row.id,
      href: workspaceSessionDetailPath(workspaceSlug, row.number),
      title: row.title,
      description: "#" + row.number,
      occurredAt: row.updated_at,
      factory: row.factory,
      actor: activityActor(row.creator_member_id, row.actor),
      status: row.archived_at ? "archived" : sessionPhaseStatusValue(row.phase_status),
    })),
  };
}

async function loadRuns({
  supabase,
  workspaceId,
  workspaceSlug,
  filters,
}: ActivityContext): Promise<ActivitySection> {
  const query = supabase
    .from("agent_runs")
    .select(
      "id,created_at,status,stage_name,model_provider,model_name,triggered_by_member_id,session:sessions!agent_runs_session_id_fkey!inner(title,factory:factories!sessions_workspace_factory_fkey!inner(id,name)),actor:workspace_members!agent_runs_triggered_by_member_id_fkey(full_name,username,kind)",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .eq("session.workspace_id", workspaceId)
    .eq("actor.workspace_id", workspaceId);
  if (filters.factoryId) query.eq("session.factory_id", filters.factoryId);
  if (filters.actorId) query.eq("triggered_by_member_id", filters.actorId);
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACTIVITY_PREVIEW_LIMIT);
  if (error || !data || count === null) return { kind: "unavailable" };

  return {
    kind: "available",
    count,
    rows: data.map((row) => ({
      id: row.id,
      href: workspaceRunDetailPath(workspaceSlug, row.id),
      title: row.session.title,
      description: [
        row.stage_name,
        RUN_PROVIDER_LABELS[row.model_provider] ?? row.model_provider,
        row.model_name,
      ]
        .filter(Boolean)
        .join(" · "),
      occurredAt: row.created_at,
      factory: row.session.factory,
      actor: activityActor(row.triggered_by_member_id, row.actor),
      status: agentRunStatusValue(row.status),
    })),
  };
}

function activityActor(id: string | null, member: Member | null): ActivityActor {
  if (!id) return null;
  return {
    id,
    label:
      member?.full_name?.trim() ||
      member?.username?.trim() ||
      (member?.kind === "system" ? "System" : id),
  };
}
