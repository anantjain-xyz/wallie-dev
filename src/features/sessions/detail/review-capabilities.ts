import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SessionReviewCapabilities = {
  canApprove: boolean;
  failedStageSlug: string | null;
  hasFailedRun: boolean;
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
      .select("approver_member_ids")
      .eq("id", stageId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);

  if (!member || !stage) return false;

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
}): Promise<{ failedStageSlug: string | null; hasFailedRun: boolean }> {
  const { data: latestRun } = await supabase
    .from("agent_runs")
    .select("stage_slug, status")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRun || latestRun.status !== "error") {
    return { failedStageSlug: null, hasFailedRun: false };
  }

  return {
    failedStageSlug: latestRun.stage_slug ?? null,
    hasFailedRun: true,
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
  };
}
