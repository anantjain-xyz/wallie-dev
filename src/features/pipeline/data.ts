import "server-only";

import { z } from "zod";

import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import { encodePipelineDashboardCursor } from "@/features/pipeline/cursor";
import type {
  PipelineDashboardData,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";
import { PIPELINE_DASHBOARD_PAGE_SIZE } from "@/features/pipeline/types";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
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

type PipelineDashboardRpcArgs = {
  cursor_seen_ids?: string[];
  page_limit: number;
  target_pipeline_id?: string;
  target_stage_id?: string;
  target_workspace_id: string;
};

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

type PipelineDashboardRpcResult = PromiseLike<{
  data: unknown;
  error: { message: string } | null;
}>;

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
    cards: Array.isArray(lane.cards) ? lane.cards.slice(0, PIPELINE_DASHBOARD_PAGE_SIZE) : [],
    cursor: lane.cursor ? encodePipelineDashboardCursor(lane.cursor) : null,
    description: lane.description,
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
  return lanes.filter((lane) => !archivedStageIds.has(lane.id) || lane.totalCount > 0);
}

async function queryPipelineDashboard(
  supabase: SupabaseServerClient,
  args: PipelineDashboardRpcArgs,
) {
  const client = supabase as unknown as {
    rpc: (
      name: "get_pipeline_dashboard_page",
      args: PipelineDashboardRpcArgs,
    ) => PipelineDashboardRpcResult;
  };

  return client.rpc("get_pipeline_dashboard_page", args);
}

export async function loadPipelineDashboardLanePage({
  pipelineId,
  seenIds,
  stageId,
  supabase,
  workspaceId,
}: {
  pipelineId: string;
  seenIds: string[];
  stageId: string;
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<PipelineDashboardLanePage | null> {
  const { data, error } = await queryPipelineDashboard(supabase, {
    cursor_seen_ids: seenIds,
    page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
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
  supabase,
  workspaceId,
}: {
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<Pick<PipelineDashboardData, "lanes" | "hasAnySession" | "onboarding">> {
  const [onboardingResult, dashboard, archivedStages, anySessionResult] = await Promise.all([
    supabase
      .from("workspace_onboarding")
      .select("current_step, status")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    queryPipelineDashboard(supabase, {
      page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
      target_workspace_id: workspaceId,
    }),
    supabase.from("pipeline_stages").select("id, archived_at").eq("workspace_id", workspaceId),
    supabase.from("sessions").select("id").eq("workspace_id", workspaceId).limit(1),
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
        () => loadPipelineDashboardSnapshot({ supabase, workspaceId: workspace.id }),
        (snapshot) => ({
          payloadBytes: approximatePayloadSizeBytes(snapshot),
          rows: snapshot.lanes.reduce((count, lane) => count + lane.cards.length, 0),
        }),
      );

      const result: PipelineDashboardData = {
        ...snapshot,
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
