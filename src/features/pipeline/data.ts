import "server-only";

import { notFound, redirect } from "next/navigation";

import { getWorkspaceBySlugForUser, workspaceLoginRedirectPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SessionPhase, SessionPhaseStatus } from "@/features/sessions/types";

export type PipelineDashboardCard = {
  createdAt: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phase: SessionPhase;
  phaseStatus: SessionPhaseStatus;
  rejectionCount: number;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  title: string;
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

  // RLS scopes sessions to workspace membership, so the workspace_id filter
  // here is defense-in-depth rather than a primary access gate.
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
        phase,
        phase_status,
        rejection_count,
        slack_channel_id,
        slack_thread_ts,
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

  const cards = (data ?? []).map<PipelineDashboardCard>((row) => ({
    createdAt: row.created_at,
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phase: row.phase as SessionPhase,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    rejectionCount: row.rejection_count,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  }));

  return {
    cards,
    workspace,
  };
}
