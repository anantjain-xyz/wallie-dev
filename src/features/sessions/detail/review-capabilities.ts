import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { StageExecution } from "./stage-execution";

export type SessionReviewCapabilities = {
  canApprove: boolean;
  failedStageSlug: string | null;
  hasFailedRun: boolean;
  latestRun: StageExecution | null;
};

export async function resolveCanApprove({
  memberUserId,
  stageId,
  supabase,
  workspaceId,
}: {
  memberUserId: string;
  stageId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
}): Promise<boolean> {
  const [{ data: member }, { data: stage }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("id, role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", memberUserId)
      .eq("is_active", true)
      .eq("kind", "human")
      .maybeSingle(),
    supabase
      .from("pipeline_stages")
      .select("anyone_can_approve, approver_member_ids")
      .eq("id", stageId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);

  if (!member || !stage) return false;

  if (stage.anyone_can_approve) return true;

  const approvers = stage.approver_member_ids ?? [];
  if (approvers.length > 0) {
    return approvers.includes(member.id);
  }

  return member.role === "owner" || member.role === "admin";
}

export async function resolveLatestRunFailure({
  sessionId,
  supabase,
}: {
  sessionId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
}): Promise<Pick<SessionReviewCapabilities, "failedStageSlug" | "hasFailedRun" | "latestRun">> {
  const { data: latestRun } = await supabase
    .from("agent_runs")
    .select("id, stage_id, stage_slug, status, created_at, updated_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    failedStageSlug: latestRun?.status === "error" ? (latestRun.stage_slug ?? null) : null,
    hasFailedRun: latestRun?.status === "error",
    latestRun: latestRun
      ? {
          id: latestRun.id,
          stageId: latestRun.stage_id,
          status: latestRun.status,
          createdAt: latestRun.created_at,
          updatedAt: latestRun.updated_at,
        }
      : null,
  };
}

export async function loadSessionReviewCapabilities({
  memberUserId,
  sessionId,
  stageId,
  supabase,
  workspaceId,
}: {
  memberUserId: string;
  sessionId: string;
  stageId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
}): Promise<SessionReviewCapabilities> {
  const [canApprove, failure] = await Promise.all([
    resolveCanApprove({ memberUserId, stageId, supabase, workspaceId }),
    resolveLatestRunFailure({ sessionId, supabase }),
  ]);

  return {
    canApprove,
    failedStageSlug: failure.failedStageSlug,
    hasFailedRun: failure.hasFailedRun,
    latestRun: failure.latestRun,
  };
}
