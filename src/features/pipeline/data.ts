import "server-only";

import { z } from "zod";

import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import type {
  PipelineDashboardData,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";
import { PIPELINE_DASHBOARD_PAGE_SIZE } from "@/features/pipeline/types";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

type PipelineDashboardCursor = {
  attentionRank: number;
  id: string;
  pipelineId: string;
  snapshotAt: string;
  stageId: string;
  updatedAt: string;
};

type PipelineDashboardRpcArgs = {
  cursor_attention_rank?: number;
  cursor_id?: string;
  cursor_snapshot_at?: string;
  cursor_updated_at?: string;
  page_limit: number;
  target_pipeline_id?: string;
  target_stage_id?: string;
  target_workspace_id: string;
};

type PipelineDashboardRpcCursor = {
  attentionRank: number;
  id: string;
  pipelineId: string;
  snapshotAt: string;
  stageId: string;
  updatedAt: string;
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
  attentionRank: z.number().int().min(0).max(1),
  id: z.string().uuid(),
  pipelineId: z.string().uuid(),
  snapshotAt: z.string().datetime({ offset: true }),
  stageId: z.string().uuid(),
  updatedAt: z.string().datetime({ offset: true }),
});

function encodeCursor(cursor: PipelineDashboardRpcCursor | null) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

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
    cursor: encodeCursor(lane.cursor),
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
  cursor,
  pipelineId,
  stageId,
  supabase,
  workspaceId,
}: {
  cursor: PipelineDashboardCursor;
  pipelineId: string;
  stageId: string;
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<PipelineDashboardLanePage | null> {
  const { data, error } = await queryPipelineDashboard(supabase, {
    cursor_attention_rank: cursor.attentionRank,
    cursor_id: cursor.id,
    cursor_snapshot_at: cursor.snapshotAt,
    cursor_updated_at: cursor.updatedAt,
    page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
    target_pipeline_id: pipelineId,
    target_stage_id: stageId,
    target_workspace_id: workspaceId,
  });

  if (error) throw error;

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

export async function loadPipelineDashboardData(
  workspaceSlug: string,
): Promise<PipelineDashboardData> {
  return withServerTiming(
    "pipeline.dashboard",
    { pageSize: PIPELINE_DASHBOARD_PAGE_SIZE, queryCount: 2, workspaceSlug },
    async (timing) => {
      const { supabase, workspace } = await timing.segment(
        "auth-workspace-context",
        () => loadAuthenticatedWorkspaceContext(workspaceSlug),
        (context) => ({ rows: 1, workspaceId: context.workspace.id }),
      );

      const [onboardingResult, dashboardResult] = await Promise.all([
        timing.segment(
          "pipeline.onboarding",
          () =>
            supabase
              .from("workspace_onboarding")
              .select("current_step, status")
              .eq("workspace_id", workspace.id)
              .maybeSingle(),
          (result) => ({
            payloadBytes: approximatePayloadSizeBytes(result.data),
            rows: result.data ? 1 : 0,
          }),
        ),
        timing.segment(
          "pipeline.page-rpc",
          () =>
            queryPipelineDashboard(supabase, {
              page_limit: PIPELINE_DASHBOARD_PAGE_SIZE,
              target_workspace_id: workspace.id,
            }),
          (result) => ({
            payloadBytes: approximatePayloadSizeBytes(result.data),
            rows: normalizePipelineDashboardRpcPayload(result.data).lanes.reduce(
              (count, lane) => count + lane.cards.length,
              0,
            ),
          }),
        ),
      ]);

      if (onboardingResult.error) throw onboardingResult.error;
      if (dashboardResult.error) throw dashboardResult.error;

      const dashboard = normalizePipelineDashboardRpcPayload(dashboardResult.data);
      const result: PipelineDashboardData = {
        lanes: dashboard.lanes,
        onboarding: mapOnboardingResumeState(onboardingResult.data),
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
