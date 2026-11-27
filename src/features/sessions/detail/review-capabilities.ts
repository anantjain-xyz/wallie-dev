import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadPinnedFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import type { Tables } from "@/lib/supabase/database.types";
import { canManageSessionRetainedContent } from "./retained-content-access";
import type { StageExecution } from "./stage-execution";

export type SessionReviewCapabilities = {
  canApprove: boolean;
  canManageRetainedContent: boolean;
  factoryId?: string;
  factoryName?: string;
  failedStageSlug: string | null;
  hasFailedRun: boolean;
  latestRun: StageExecution | null;
};

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type ReviewSession = Pick<
  Tables<"sessions">,
  "pipeline_id" | "workspace_id" | "factory_definition_revision_id" | "execute_pinned_definition"
>;

export async function loadSessionStageApprovers(
  supabase: Supabase,
  session: ReviewSession,
  stageId: string,
) {
  const pinned = await loadPinnedFactoryExecution(supabase, session);
  if (pinned) return pinned.stages.find(({ id }) => id === stageId) ?? null;

  const { data: stage, error } = await supabase
    .from("pipeline_stages")
    .select("anyone_can_approve, approver_member_ids")
    .eq("id", stageId)
    .eq("workspace_id", session.workspace_id)
    .eq("pipeline_id", session.pipeline_id)
    .maybeSingle();
  if (error) throw error;
  return stage
    ? {
        anyoneCanApprove: stage.anyone_can_approve,
        approverMemberIds: stage.approver_member_ids ?? [],
      }
    : null;
}

export function canApproveSessionStage(
  stage: Awaited<ReturnType<typeof loadSessionStageApprovers>>,
  member: Pick<Tables<"workspace_members">, "id" | "role">,
) {
  if (!stage) return false;
  if (stage.anyoneCanApprove) return true;
  return stage.approverMemberIds.length > 0
    ? stage.approverMemberIds.includes(member.id)
    : member.role === "owner" || member.role === "admin";
}

async function resolveViewerCapabilities({
  includeFactoryScope,
  memberUserId,
  sessionId,
  stageId,
  supabase,
  workspaceId,
}: {
  includeFactoryScope: boolean;
  memberUserId: string;
  sessionId: string;
  stageId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
}): Promise<
  Pick<
    SessionReviewCapabilities,
    "canApprove" | "canManageRetainedContent" | "factoryId" | "factoryName"
  >
> {
  const sessionColumns =
    "pipeline_id, workspace_id, factory_id, execute_pinned_definition, factory_definition_revision_id";
  const sessionQuery = supabase.from("sessions");
  const sessionRead = (
    includeFactoryScope
      ? sessionQuery.select(
          `${sessionColumns}, factory:factories!sessions_workspace_factory_fkey(name)`,
        )
      : sessionQuery.select(sessionColumns)
  )
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const [{ data: member, error: memberError }, { data: session, error: sessionError }] =
    await Promise.all([
      supabase
        .from("workspace_members")
        .select("id, role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", memberUserId)
        .eq("is_active", true)
        .eq("kind", "human")
        .maybeSingle(),
      sessionRead,
    ]);

  if (memberError || sessionError || !member || !session) {
    return { canApprove: false, canManageRetainedContent: false };
  }
  const [stage, canManageRetainedContent] = await Promise.all([
    loadSessionStageApprovers(supabase, session, stageId),
    canManageSessionRetainedContent(
      supabase,
      { workspaceId, factoryId: session.factory_id },
      member,
    ),
  ]);
  const factory = "factory" in session ? session.factory : null;
  const factoryName =
    factory && typeof factory === "object" && "name" in factory && typeof factory.name === "string"
      ? factory.name
      : undefined;
  return {
    canApprove: canApproveSessionStage(stage, member),
    canManageRetainedContent,
    ...(includeFactoryScope ? { factoryId: session.factory_id } : {}),
    ...(factoryName ? { factoryName } : {}),
  };
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
  includeFactoryScope = false,
  memberUserId,
  sessionId,
  stageId,
  supabase,
  workspaceId,
}: {
  includeFactoryScope?: boolean;
  memberUserId: string;
  sessionId: string;
  stageId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
}): Promise<SessionReviewCapabilities> {
  const [viewer, failure] = await Promise.all([
    resolveViewerCapabilities({
      includeFactoryScope,
      memberUserId,
      sessionId,
      stageId,
      supabase,
      workspaceId,
    }),
    resolveLatestRunFailure({ sessionId, supabase }),
  ]);

  return {
    ...viewer,
    failedStageSlug: failure.failedStageSlug,
    hasFailedRun: failure.hasFailedRun,
    latestRun: failure.latestRun,
  };
}
