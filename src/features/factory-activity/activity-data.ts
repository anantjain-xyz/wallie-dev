import "server-only";

import {
  agentRunStatusValue,
  sessionPhaseStatusValue,
  type StatusValue,
} from "@/components/ui/status";
import {
  type ActivityActor,
  type ActivityKind,
  type ActivityQuery,
} from "@/features/factory-activity/activity-query";
import {
  olderActivityQuery,
  readActivityCursor,
  type ActivityPosition,
} from "@/features/factory-activity/activity-query.server";
import { RUN_PROVIDER_LABELS } from "@/features/wallie/runs-list-state";
import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceRunDetailPath, workspaceSessionDetailPath } from "@/lib/routes";
import type { Tables } from "@/lib/supabase/database.types";

const ACTIVITY_PREVIEW_LIMIT = 10;

type ActivityContext = Pick<AuthenticatedWorkspaceContext, "supabase"> & {
  workspaceId: string;
  workspaceSlug: string;
  query: ActivityQuery;
};

type Factory = Pick<Tables<"factories">, "id" | "name">;
type Member = Pick<Tables<"workspace_members">, "full_name" | "username" | "kind">;

export type ActivityRow = {
  id: string;
  href: string;
  title: string;
  description: string | null;
  time: string;
  factory: Factory;
  actor: ActivityActor | null;
  status: StatusValue;
};

export type ActivitySection =
  | { kind: "available"; count: number; rows: ActivityRow[]; olderQuery?: ActivityQuery }
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
  query,
}: ActivityContext): Promise<ActivitySection> {
  const position = readActivityCursor(query.sessionsBefore, workspaceId, "sessions", query);
  function scoped(head: boolean) {
    const result = supabase
      .from("sessions")
      .select(
        "id,number,title,phase_status,archived_at,updated_at,creator_member_id,factory:factories!sessions_workspace_factory_fkey!inner(id,name),actor:workspace_members!sessions_creator_member_id_fkey(full_name,username,kind)",
        { count: head || !position ? "exact" : undefined, head },
      )
      .eq("workspace_id", workspaceId)
      .eq("actor.workspace_id", workspaceId);
    if (query.factory !== "all") result.eq("factory_id", query.factory);
    if (query.actor) result.eq("creator_member_id", query.actor);
    return result;
  }
  const page = scoped(false)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACTIVITY_PREVIEW_LIMIT + 1);
  if (position) page.or(before("updated_at", position));
  const [result, total] = await Promise.all([page, position ? scoped(true) : null]);
  const count = total ? total.count : result.count;
  if (result.error || total?.error || !result.data || count === null)
    return { kind: "unavailable" };

  return availableSection(
    "sessions",
    count,
    result.data.map((row) => ({
      id: row.id,
      href: workspaceSessionDetailPath(workspaceSlug, row.number),
      title: row.title,
      description: "#" + row.number,
      time: row.updated_at,
      factory: row.factory,
      actor: activityActor(row.creator_member_id, row.actor),
      status: row.archived_at ? "archived" : sessionPhaseStatusValue(row.phase_status),
    })),
    query,
    workspaceId,
  );
}

async function loadRuns({
  supabase,
  workspaceId,
  workspaceSlug,
  query,
}: ActivityContext): Promise<ActivitySection> {
  const position = readActivityCursor(query.runsBefore, workspaceId, "runs", query);
  function scoped(head: boolean) {
    const result = supabase
      .from("agent_runs")
      .select(
        "id,created_at,status,stage_name,model_provider,model_name,triggered_by_member_id,session:sessions!agent_runs_session_id_fkey!inner(title,factory:factories!sessions_workspace_factory_fkey!inner(id,name)),actor:workspace_members!agent_runs_triggered_by_member_id_fkey(full_name,username,kind)",
        { count: head || !position ? "exact" : undefined, head },
      )
      .eq("workspace_id", workspaceId)
      .eq("session.workspace_id", workspaceId)
      .eq("actor.workspace_id", workspaceId);
    if (query.factory !== "all") result.eq("session.factory_id", query.factory);
    if (query.actor) result.eq("triggered_by_member_id", query.actor);
    if (query.status) result.eq("status", query.status);
    return result;
  }
  const page = scoped(false)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACTIVITY_PREVIEW_LIMIT + 1);
  if (position) page.or(before("created_at", position));
  const [result, total] = await Promise.all([page, position ? scoped(true) : null]);
  const count = total ? total.count : result.count;
  if (result.error || total?.error || !result.data || count === null)
    return { kind: "unavailable" };

  return availableSection(
    "runs",
    count,
    result.data.map((row) => ({
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
      time: row.created_at,
      factory: row.session.factory,
      actor: activityActor(row.triggered_by_member_id, row.actor),
      status: agentRunStatusValue(row.status),
    })),
    query,
    workspaceId,
  );
}

function before(column: "updated_at" | "created_at", { time, id }: ActivityPosition) {
  return `${column}.lt.${time},and(${column}.eq.${time},id.lt.${id})`;
}

function availableSection(
  kind: ActivityKind,
  count: number,
  rows: ActivityRow[],
  query: ActivityQuery,
  workspaceId: string,
): ActivitySection {
  const page = rows.slice(0, ACTIVITY_PREVIEW_LIMIT);
  const last = page.at(-1);
  return {
    kind: "available",
    count,
    rows: page,
    ...(last && rows.length > page.length
      ? {
          olderQuery: olderActivityQuery(query, workspaceId, kind, {
            id: last.id,
            time: last.time,
          }),
        }
      : {}),
  };
}

function activityActor(id: string | null, member: Member | null): ActivityActor | null {
  if (!id) return null;
  return {
    id,
    label:
      member?.full_name?.trim() ||
      (member?.username?.trim() && `@${member.username.trim()}`) ||
      (member?.kind === "system" ? "System" : "Name unavailable"),
  };
}
