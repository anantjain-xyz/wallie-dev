import { workspaceActivityPath } from "@/lib/routes";
import type { Enums } from "@/lib/supabase/database.types";

export const ACTIVITY_CURSOR_PARAM = { sessions: "sessionsBefore", runs: "runsBefore" } as const;
export const ACTIVITY_CURSOR_PARAMS = Object.values(ACTIVITY_CURSOR_PARAM);

export type ActivityKind = keyof typeof ACTIVITY_CURSOR_PARAM;
export type ActivityRunStatus = Enums<"agent_run_status">;
export type ActivityQuery = {
  factory: string;
  actor?: string;
  status?: ActivityRunStatus;
  sessionsBefore?: string;
  runsBefore?: string;
};
export type ActivityActor = { id: string; label: string };
export type ActivityActorSearch = { actors: ActivityActor[]; hasMore: boolean };

export function activityHref(workspaceSlug: string, query: ActivityQuery, section?: ActivityKind) {
  return workspaceActivityPath(workspaceSlug, query) + (section ? `#activity-${section}` : "");
}

export function activityActorSearchHref(workspaceSlug: string, factory: string, term: string) {
  const query = new URLSearchParams({ factory, q: term });
  return `${workspaceActivityPath(workspaceSlug)}/actors?${query}`;
}
