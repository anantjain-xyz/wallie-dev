import "server-only";

import { notFound, redirect } from "next/navigation";

import { getWorkspaceBySlugForUser, workspaceLoginRedirectPath } from "@/lib/auth";
import type { PipelinePhase, PipelinePhaseStatus } from "@/lib/pipeline/types";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PipelineDashboardCard = {
  createdAt: string;
  id: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  phase: PipelinePhase;
  phaseStatus: PipelinePhaseStatus;
  rejectionCount: number;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  updatedAt: string;
  workspaceId: string;
};

export type PipelineDashboardData = {
  cards: PipelineDashboardCard[];
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

  // RLS scopes pipeline_issues to workspace membership, so the workspace_id
  // filter here is defense-in-depth rather than a primary access gate.
  const { data, error } = await supabase
    .from("pipeline_issues")
    .select(
      `
        id,
        created_at,
        updated_at,
        issue_id,
        linear_issue_id,
        linear_issue_url,
        phase,
        phase_status,
        rejection_count,
        slack_channel_id,
        slack_thread_ts,
        workspace_id,
        issues:issue_id ( title, number )
      `,
    )
    .eq("workspace_id", workspace.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  type Row = (typeof data)[number] & {
    issues: { number: number | null; title: string | null } | null;
  };

  const cards = ((data ?? []) as Row[]).map<PipelineDashboardCard>((row) => ({
    createdAt: row.created_at,
    id: row.id,
    issueId: row.issue_id,
    issueNumber: row.issues?.number ?? null,
    issueTitle: row.issues?.title ?? "Untitled issue",
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    phase: row.phase,
    phaseStatus: row.phase_status,
    rejectionCount: row.rejection_count,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  }));

  return {
    cards,
    workspace,
  };
}
