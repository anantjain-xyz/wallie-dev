import "server-only";

import { notFound } from "next/navigation";

import type { WorkspaceSummary } from "@/lib/auth";
import type { Tables } from "@/lib/supabase/database.types";
import { loadSessionWorkspaceContext } from "@/features/sessions/server";
import {
  type SessionArtifactSummary,
  type SessionDetail,
  type SessionPhase,
  type SessionPhaseCompletion,
  type SessionPhaseStatus,
  type SessionPullRequest,
  type SessionRun,
} from "@/features/sessions/types";
import { loadWallieIssueData } from "@/features/wallie/server";
import type { WallieIssueData } from "@/features/wallie/types";
import type { IssueDetail, IssueMember } from "@/features/issues/types";
import { mapIssueDetailRow } from "@/features/issues/model";

export type SessionDetailPageData = {
  currentMember: IssueMember | null;
  issue: IssueDetail;
  members: IssueMember[];
  memberIndex: ReadonlyMap<string, IssueMember>;
  session: SessionDetail;
  wallie: WallieIssueData;
  workspace: WorkspaceSummary;
};

type PipelineIssueRow = Pick<
  Tables<"pipeline_issues">,
  | "created_at"
  | "current_artifact_version"
  | "design_approved_at"
  | "engineering_approved_at"
  | "id"
  | "issue_id"
  | "linear_issue_id"
  | "linear_issue_url"
  | "phase"
  | "phase_status"
  | "product_approved_at"
  | "rejection_count"
  | "shipped_at"
  | "slack_channel_id"
  | "slack_thread_ts"
  | "updated_at"
  | "workspace_id"
>;

const legacyPhaseCompletionFields: Array<{
  field: keyof PipelineIssueRow;
  phase: SessionPhase;
}> = [
  { field: "product_approved_at", phase: "product" },
  { field: "design_approved_at", phase: "design" },
  { field: "engineering_approved_at", phase: "engineering" },
  { field: "shipped_at", phase: "review" },
];

function buildPhaseCompletions(row: PipelineIssueRow): SessionPhaseCompletion[] {
  const completions: SessionPhaseCompletion[] = [];
  for (const entry of legacyPhaseCompletionFields) {
    const value = row[entry.field];
    if (typeof value === "string" && value) {
      completions.push({ completedAt: value, phase: entry.phase });
    }
  }
  return completions;
}

export async function loadSessionDetailPageData(
  workspaceSlug: string,
  sessionNumberValue: string,
): Promise<SessionDetailPageData> {
  const sessionNumber = Number(sessionNumberValue);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1) {
    notFound();
  }

  const context = await loadSessionWorkspaceContext(workspaceSlug);

  const { data: issueData, error: issueError } = await context.supabase
    .from("issues")
    .select("*")
    .eq("workspace_id", context.workspace.id)
    .eq("number", sessionNumber)
    .maybeSingle();

  if (issueError) {
    throw issueError;
  }
  if (!issueData) {
    notFound();
  }

  const issue = mapIssueDetailRow(issueData as Tables<"issues">, context.memberIndex);

  const { data: pipelineRow, error: pipelineError } = await context.supabase
    .from("pipeline_issues")
    .select(
      "id, created_at, updated_at, issue_id, linear_issue_id, linear_issue_url, phase, phase_status, current_artifact_version, rejection_count, slack_channel_id, slack_thread_ts, workspace_id, product_approved_at, design_approved_at, engineering_approved_at, shipped_at",
    )
    .eq("workspace_id", context.workspace.id)
    .eq("issue_id", issue.id)
    .maybeSingle();

  if (pipelineError) {
    throw pipelineError;
  }
  if (!pipelineRow) {
    notFound();
  }

  const pipeline = pipelineRow as PipelineIssueRow;

  const [
    { data: artifactRows, error: artifactError },
    { data: prRows, error: prError },
    { data: runRows, error: runError },
  ] = await Promise.all([
    context.supabase
      .from("pipeline_artifacts")
      .select("artifact_json, created_at, phase, version")
      .eq("pipeline_issue_id", pipeline.id)
      .order("version", { ascending: false }),
    context.supabase
      .from("github_issue_branches")
      .select(
        "id, github_repository_id, branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft, updated_at",
      )
      .eq("workspace_id", context.workspace.id)
      .eq("issue_id", issue.id)
      .order("created_at", { ascending: false }),
    context.supabase
      .from("agent_runs")
      .select("id, created_at, finished_at, model_name, run_type, started_at, status")
      .eq("issue_id", issue.id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (artifactError) throw artifactError;
  if (prError) throw prError;
  if (runError) throw runError;

  const artifacts: SessionArtifactSummary[] = ((artifactRows ?? []) as Array<
    Pick<Tables<"pipeline_artifacts">, "artifact_json" | "created_at" | "phase" | "version">
  >).map((row) => ({
    createdAt: row.created_at,
    phase: row.phase as SessionPhase,
    payload: row.artifact_json,
    version: row.version,
  }));

  const repoIds = Array.from(
    new Set(
      ((prRows ?? []) as Array<{ github_repository_id: string | null }>)
        .map((row) => row.github_repository_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let repositoryIndex = new Map<
    string,
    { fullName: string; htmlUrl: string }
  >();
  if (repoIds.length > 0) {
    const { data: repoRows, error: repoError } = await context.supabase
      .from("github_repositories")
      .select("id, full_name, html_url")
      .in("id", repoIds);
    if (repoError) {
      throw repoError;
    }
    repositoryIndex = new Map(
      ((repoRows ?? []) as Array<{ full_name: string; html_url: string; id: string }>).map(
        (row) => [row.id, { fullName: row.full_name, htmlUrl: row.html_url }],
      ),
    );
  }

  const pullRequests: SessionPullRequest[] = ((prRows ?? []) as Array<
    Pick<
      Tables<"github_issue_branches">,
      | "branch_name"
      | "github_repository_id"
      | "id"
      | "is_draft"
      | "pull_request_number"
      | "pull_request_state"
      | "pull_request_url"
      | "updated_at"
    >
  >).map((row) => {
    const repo = row.github_repository_id ? repositoryIndex.get(row.github_repository_id) : null;
    return {
      branchName: row.branch_name,
      id: row.id,
      isDraft: row.is_draft,
      pullRequestNumber: row.pull_request_number,
      pullRequestState: row.pull_request_state,
      pullRequestUrl: row.pull_request_url,
      repositoryFullName: repo?.fullName ?? null,
      repositoryHtmlUrl: repo?.htmlUrl ?? null,
      updatedAt: row.updated_at,
    };
  });

  const runHistory: SessionRun[] = ((runRows ?? []) as Array<
    Pick<
      Tables<"agent_runs">,
      "created_at" | "finished_at" | "id" | "model_name" | "run_type" | "started_at" | "status"
    >
  >).map((row) => ({
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    modelName: row.model_name,
    runType: row.run_type,
    startedAt: row.started_at,
    status: row.status,
  }));

  const session: SessionDetail = {
    archivedAt: issue.status === "canceled" ? issue.updatedAt : null,
    artifacts,
    createdAt: pipeline.created_at,
    currentArtifactVersion: pipeline.current_artifact_version,
    id: pipeline.id,
    linearIssueId: pipeline.linear_issue_id,
    linearIssueUrl: pipeline.linear_issue_url,
    number: issue.number,
    phase: pipeline.phase as SessionPhase,
    phaseStatus: pipeline.phase_status as SessionPhaseStatus,
    phaseCompletions: buildPhaseCompletions(pipeline),
    promptMd: issue.descriptionMd,
    pullRequestCount: pullRequests.length,
    pullRequests,
    rejectionCount: pipeline.rejection_count,
    runHistory,
    slackChannelId: pipeline.slack_channel_id,
    slackThreadTs: pipeline.slack_thread_ts,
    title: issue.title,
    updatedAt: pipeline.updated_at,
    workspaceId: pipeline.workspace_id,
  };

  const { data: repoForIssueData, error: repoForIssueError } = issue.githubRepositoryId
    ? await context.supabase
        .from("github_repositories")
        .select(
          "id, full_name, html_url, private, default_programming_language, default_branch, is_archived",
        )
        .eq("id", issue.githubRepositoryId)
        .maybeSingle()
    : { data: null, error: null };

  if (repoForIssueError) {
    throw repoForIssueError;
  }

  const wallie = await loadWallieIssueData({
    issue: issueData as Pick<Tables<"issues">, "github_repository_id" | "id">,
    memberIndex: context.memberIndex,
    repository: repoForIssueData
      ? {
          defaultBranch: repoForIssueData.default_branch,
          defaultProgrammingLanguage: repoForIssueData.default_programming_language,
          fullName: repoForIssueData.full_name,
          htmlUrl: repoForIssueData.html_url,
          id: repoForIssueData.id,
          isArchived: repoForIssueData.is_archived,
          isPrivate: repoForIssueData.private,
        }
      : null,
    supabase: context.supabase,
    workspaceId: context.workspace.id,
  });

  return {
    currentMember: context.currentMember,
    issue,
    memberIndex: context.memberIndex,
    members: context.members,
    session,
    wallie,
    workspace: context.workspace,
  };
}
