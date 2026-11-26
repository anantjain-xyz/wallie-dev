import "server-only";

import { z } from "zod";

import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import { encodePipelineDashboardCursor } from "@/features/pipeline/cursor";
import type {
  PipelineDashboardData,
  PipelineDashboardFilters,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";
import { PIPELINE_DASHBOARD_PAGE_SIZE } from "@/features/pipeline/types";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import type { Database } from "@/lib/supabase/database.types";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export class PipelineWorkspaceUnavailableError extends Error {
  constructor() {
    super("Workspace not found.");
  }
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

type PipelineDashboardCursor = {
  pipelineId: string;
  stageId: string;
};

type PipelineDashboardRpcArgs =
  Database["public"]["Functions"]["get_filtered_pipeline_dashboard_page"]["Args"];

type PipelineDashboardRpcCursor = {
  pipelineId: string;
  stageId: string;
};

type PipelineDashboardRpcLane = Omit<PipelineDashboardLane, "cursor"> & {
  cursor: PipelineDashboardRpcCursor | null;
};

type PipelineDashboardRpcPayload = {
  lanes?: PipelineDashboardRpcLane[];
};

const cursorSchema = z.object({
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
});

export function decodePipelineDashboardCursor(raw: string | null): PipelineDashboardCursor | null {
  if (!raw) return null;

  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function normalizeLane(lane: PipelineDashboardRpcLane): PipelineDashboardLane {
  return {
    ...(lane.activeCount !== undefined ? { activeCount: lane.activeCount } : {}),
    cards: Array.isArray(lane.cards) ? lane.cards.slice(0, PIPELINE_DASHBOARD_PAGE_SIZE) : [],
    cursor: lane.cursor ? encodePipelineDashboardCursor(lane.cursor) : null,
    description: lane.description,
    ...(lane.factoryName !== undefined ? { factoryName: lane.factoryName } : {}),
    id: lane.id,
    name: lane.name,
    pipeline: lane.pipeline,
    position: lane.position,
    slug: lane.slug,
    totalCount: lane.totalCount,
  };
}

export function normalizePipelineDashboardRpcPayload(payload: unknown) {
  const rpcPayload = (payload ?? {}) as PipelineDashboardRpcPayload;
  return {
    lanes: (rpcPayload.lanes ?? []).map(normalizeLane),
  };
}

export function filterArchivedPipelineDashboardLanes(
  lanes: PipelineDashboardLane[],
  archivedStageIds: ReadonlySet<string>,
): PipelineDashboardLane[] {
  return lanes.filter(
    (lane) => !archivedStageIds.has(lane.id) || (lane.activeCount ?? lane.totalCount) > 0,
  );
}

async function queryPipelineDashboard(
  supabase: SupabaseServerClient,
  args: PipelineDashboardRpcArgs,
) {
  return supabase.rpc("get_filtered_pipeline_dashboard_page", args);
}

function filterArgs(filters: PipelineDashboardFilters | undefined) {
  return {
    ...(filters?.query ? { search_query: filters.query } : {}),
    ...(filters && filters.status !== "all" ? { status_filter: filters.status } : {}),
  };
}

export async function loadPipelineDashboardLanePage({
  factoryId,
  filters,
  pipelineId,
  seenIds,
  stageId,
  supabase,
  workspaceId,
}: {
  factoryId?: string;
  filters?: PipelineDashboardFilters;
  pipelineId: string;
  seenIds: string[];
  stageId: string;
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<PipelineDashboardLanePage | null> {
  const { data, error } = await queryPipelineDashboard(supabase, {
    cursor_seen_ids: seenIds,
    page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
    ...(factoryId ? { target_factory_id: factoryId } : {}),
    ...filterArgs(filters),
    target_pipeline_id: pipelineId,
    target_stage_id: stageId,
    target_workspace_id: workspaceId,
  });

  if (error) throw error;
  if (data === null) throw new PipelineWorkspaceUnavailableError();

  const lane = normalizePipelineDashboardRpcPayload(data).lanes[0];
  if (!lane) return null;

  return {
    cards: lane.cards,
    cursor: lane.cursor,
    id: lane.id,
    pipeline: lane.pipeline,
    totalCount: lane.totalCount,
  };
}

/** The bounded authoritative board snapshot used by initial render and recovery. */
export async function loadPipelineDashboardSnapshot({
  factoryId,
  filters,
  supabase,
  workspaceId,
}: {
  factoryId?: string;
  filters?: PipelineDashboardFilters;
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<Pick<PipelineDashboardData, "lanes" | "hasAnySession" | "onboarding">> {
  const sessions = supabase.from("sessions").select("id").eq("workspace_id", workspaceId);
  const scopedSessions = factoryId ? sessions.eq("factory_id", factoryId) : sessions;
  const [onboardingResult, dashboard, archivedStages, anySessionResult] = await Promise.all([
    supabase
      .from("workspace_onboarding")
      .select("current_step, status")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    queryPipelineDashboard(supabase, {
      page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
      target_workspace_id: workspaceId,
      ...(factoryId ? { target_factory_id: factoryId } : {}),
      ...filterArgs(filters),
    }),
    supabase.from("pipeline_stages").select("id, archived_at").eq("workspace_id", workspaceId),
    scopedSessions.limit(1),
  ]);
  if (dashboard.error) throw dashboard.error;
  if (dashboard.data === null) throw new PipelineWorkspaceUnavailableError();
  if (onboardingResult.error) throw onboardingResult.error;
  if (archivedStages.error) throw archivedStages.error;
  if (anySessionResult.error) throw anySessionResult.error;
  return {
    hasAnySession: (anySessionResult.data?.length ?? 0) > 0,
    onboarding: mapOnboardingResumeState(onboardingResult.data),
    lanes: filterArchivedPipelineDashboardLanes(
      normalizePipelineDashboardRpcPayload(dashboard.data).lanes,
      new Set(
        (archivedStages.data ?? [])
          .filter((stage) => stage.archived_at !== null)
          .map((stage) => stage.id),
      ),
    ),
  };
}

export async function loadPipelineDashboardData(
  workspaceSlug: string,
  factoryId?: string,
): Promise<PipelineDashboardData> {
  return withServerTiming(
    "pipeline.dashboard",
    { pageSize: PIPELINE_DASHBOARD_PAGE_SIZE, queryCount: 4, workspaceSlug },
    async (timing) => {
      const { supabase, workspace } = await timing.segment(
        "auth-workspace-context",
        () => loadAuthenticatedWorkspaceContext(workspaceSlug),
        (context) => ({ rows: 1, workspaceId: context.workspace.id }),
      );

      const snapshot = await timing.segment(
        "pipeline.snapshot",
        () => loadPipelineDashboardSnapshot({ factoryId, supabase, workspaceId: workspace.id }),
        (snapshot) => ({
          payloadBytes: approximatePayloadSizeBytes(snapshot),
          rows: snapshot.lanes.reduce((count, lane) => count + lane.cards.length, 0),
        }),
      );

      const result: PipelineDashboardData = {
        ...snapshot,
        ...(factoryId ? { factoryId } : {}),
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        },
      };

      await timing.segment("pipeline.rsc-payload", () => result, {
        payloadBytes: approximatePayloadSizeBytes(result),
        rows: result.lanes.reduce((count, lane) => count + lane.cards.length, 0),
      });

      return result;
    },
  );
}

export type {
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";
