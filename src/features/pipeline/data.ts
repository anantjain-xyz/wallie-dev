import "server-only";

import { notFound, redirect } from "next/navigation";

import { getWorkspaceBySlugForUser, workspaceLoginRedirectPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  PipelineStage,
  SessionPhaseStatus,
  SessionPullRequest,
} from "@/features/sessions/types";

type PipelineDashboardPullRequest = Pick<
  SessionPullRequest,
  | "id"
  | "isDraft"
  | "pullRequestNumber"
  | "pullRequestState"
  | "pullRequestUrl"
  | "repositoryFullName"
>;

export type PipelineDashboardCard = {
  createdAt: string;
  currentStageId: string;
  currentStageSlug: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseStatus: SessionPhaseStatus;
  pullRequests?: PipelineDashboardPullRequest[];
  rejectionCount: number;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type PipelineDashboardData = {
  cards: PipelineDashboardCard[];
  defaultPipelineStages: PipelineStage[];
  workspace: { id: string; name: string; slug: string };
};

export async function loadPipelineDashboardData(
  workspaceSlug: string,
): Promise<PipelineDashboardData> {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
  }

  const workspace = await getWorkspaceBySlugForUser(supabase, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  // Pull the default pipeline so the dashboard knows which lanes to render.
  // Sessions whose current stage isn't in the default pipeline (e.g. the
  // pipeline was edited mid-flight) fall under an "Other" lane in the UI.
  const { data: pipelineRow, error: pipelineError } = await supabase
    .from("pipelines")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("is_default", true)
    .maybeSingle();
  if (pipelineError) throw pipelineError;

  let defaultPipelineStages: PipelineStage[] = [];
  if (pipelineRow) {
    const { data: stageRows, error: stagesError } = await supabase
      .from("pipeline_stages")
      .select(
        "id, pipeline_id, position, slug, name, description, prompt_template_md, approver_member_ids",
      )
      .eq("pipeline_id", pipelineRow.id)
      .order("position", { ascending: true });
    if (stagesError) throw stagesError;
    defaultPipelineStages = (stageRows ?? []).map((s) => ({
      approverMemberIds: s.approver_member_ids ?? [],
      description: s.description,
      id: s.id,
      name: s.name,
      pipelineId: s.pipeline_id,
      position: s.position,
      promptTemplateMd: s.prompt_template_md,
      slug: s.slug,
    }));
  }

  // Load sessions with their stage joined for slug rendering.
  const { data, error } = await supabase
    .from("sessions")
    .select(
      `
        id,
        created_at,
        updated_at,
        linear_issue_id,
        linear_issue_url,
        number,
        current_stage_id,
        phase_status,
        rejection_count,
        title,
        workspace_id,
        archived_at
      `,
    )
    .eq("workspace_id", workspace.id)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const sessionIds = rows.map((row) => row.id);
  const stageIds = Array.from(new Set(rows.map((r) => r.current_stage_id))).filter(Boolean);
  const stageSlugMap = new Map<string, string>();
  if (stageIds.length > 0) {
    const { data: stageRows, error: stageError } = await supabase
      .from("pipeline_stages")
      .select("id, slug")
      .in("id", stageIds);
    if (stageError) throw stageError;
    for (const s of stageRows ?? []) {
      stageSlugMap.set(s.id, s.slug);
    }
  }

  const pullRequestsBySession = new Map<string, PipelineDashboardPullRequest[]>();
  if (sessionIds.length > 0) {
    const { data: prRows, error: prError } = await supabase
      .from("session_pull_requests")
      .select("id, session_id, is_draft, pull_request_number, pull_request_state, pull_request_url")
      .eq("workspace_id", workspace.id)
      .in("session_id", sessionIds)
      .not("pull_request_url", "is", null)
      .order("created_at", { ascending: false });

    if (prError) {
      throw prError;
    }

    for (const row of prRows ?? []) {
      const list = pullRequestsBySession.get(row.session_id) ?? [];
      list.push({
        id: row.id,
        isDraft: row.is_draft,
        pullRequestNumber: row.pull_request_number,
        pullRequestState: row.pull_request_state,
        pullRequestUrl: row.pull_request_url,
        repositoryFullName: null,
      });
      pullRequestsBySession.set(row.session_id, list);
    }
  }

  const cards: PipelineDashboardCard[] = rows.map((row) => ({
    createdAt: row.created_at,
    currentStageId: row.current_stage_id,
    currentStageSlug: stageSlugMap.get(row.current_stage_id) ?? "unknown",
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    pullRequests: pullRequestsBySession.get(row.id) ?? [],
    rejectionCount: row.rejection_count,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  }));

  return {
    cards,
    defaultPipelineStages,
    workspace,
  };
}
