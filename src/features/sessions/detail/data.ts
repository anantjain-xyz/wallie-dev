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
import type { WorkspaceMember } from "@/features/workspace-members/types";

export type SessionDetailPageData = {
  currentMember: WorkspaceMember | null;
  members: WorkspaceMember[];
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  session: SessionDetail;
  sessionGithubRepositoryId: string | null;
  sessionCreator: WorkspaceMember | null;
  wallie: WallieIssueData;
  workspace: WorkspaceSummary;
};

export async function loadSessionDetailPageData(
  workspaceSlug: string,
  sessionNumberValue: string,
): Promise<SessionDetailPageData> {
  const sessionNumber = Number(sessionNumberValue);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1) {
    notFound();
  }

  const context = await loadSessionWorkspaceContext(workspaceSlug);

  const { data: sessionRow, error: sessionError } = await context.supabase
    .from("sessions")
    .select(
      `
        id,
        archived_at,
        created_at,
        creator_member_id,
        updated_at,
        linear_issue_id,
        linear_issue_url,
        number,
        phase,
        phase_status,
        current_artifact_version,
        prompt_md,
        rejection_count,
        slack_channel_id,
        slack_thread_ts,
        title,
        workspace_id
      `,
    )
    .eq("workspace_id", context.workspace.id)
    .eq("number", sessionNumber)
    .maybeSingle();

  if (sessionError) {
    throw sessionError;
  }
  if (!sessionRow) {
    notFound();
  }

  const [
    { data: artifactRows, error: artifactError },
    { data: completionRows, error: completionError },
    { data: prRows, error: prError },
    { data: runRows, error: runError },
  ] = await Promise.all([
    context.supabase
      .from("session_artifacts")
      .select("artifact_json, created_at, phase, version")
      .eq("session_id", sessionRow.id)
      .order("version", { ascending: false }),
    context.supabase
      .from("session_phase_completions")
      .select("completed_at, phase")
      .eq("session_id", sessionRow.id),
    context.supabase
      .from("github_issue_branches")
      .select(
        "id, github_repository_id, branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft, updated_at, created_at",
      )
      .eq("workspace_id", context.workspace.id)
      .eq("session_id", sessionRow.id)
      .order("created_at", { ascending: false }),
    context.supabase
      .from("agent_runs")
      .select(
        "id, created_at, finished_at, input_tokens, model_name, output_tokens, run_type, started_at, status, total_cost_usd",
      )
      .eq("session_id", sessionRow.id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (artifactError) throw artifactError;
  if (completionError) throw completionError;
  if (prError) throw prError;
  if (runError) throw runError;

  const artifacts: SessionArtifactSummary[] = (
    (artifactRows ?? []) as Array<
      Pick<Tables<"session_artifacts">, "artifact_json" | "created_at" | "phase" | "version">
    >
  ).map((row) => ({
    createdAt: row.created_at,
    phase: row.phase as SessionPhase,
    payload: row.artifact_json,
    version: row.version,
  }));

  const phaseCompletions: SessionPhaseCompletion[] = (
    (completionRows ?? []) as Array<
      Pick<Tables<"session_phase_completions">, "completed_at" | "phase">
    >
  ).map((row) => ({
    completedAt: row.completed_at,
    phase: row.phase as SessionPhase,
  }));

  const prRowsTyped = (prRows ?? []) as Array<
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
      | "created_at"
    >
  >;

  const repoIds = Array.from(
    new Set(
      prRowsTyped.map((row) => row.github_repository_id).filter((id): id is string => Boolean(id)),
    ),
  );

  let repositoryIndex = new Map<
    string,
    {
      defaultBranch: string | null;
      defaultProgrammingLanguage: string | null;
      fullName: string;
      htmlUrl: string;
      isArchived: boolean;
      isPrivate: boolean;
    }
  >();
  if (repoIds.length > 0) {
    const { data: repoRows, error: repoError } = await context.supabase
      .from("github_repositories")
      .select(
        "id, full_name, html_url, private, default_programming_language, default_branch, is_archived",
      )
      .in("id", repoIds);
    if (repoError) {
      throw repoError;
    }
    repositoryIndex = new Map(
      (
        (repoRows ?? []) as Array<
          Pick<
            Tables<"github_repositories">,
            | "default_branch"
            | "default_programming_language"
            | "full_name"
            | "html_url"
            | "id"
            | "is_archived"
            | "private"
          >
        >
      ).map((row) => [
        row.id,
        {
          defaultBranch: row.default_branch,
          defaultProgrammingLanguage: row.default_programming_language,
          fullName: row.full_name,
          htmlUrl: row.html_url,
          isArchived: row.is_archived,
          isPrivate: row.private,
        },
      ]),
    );
  }

  const pullRequests: SessionPullRequest[] = prRowsTyped.map((row) => {
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

  const runHistory: SessionRun[] = (
    (runRows ?? []) as Array<
      Pick<
        Tables<"agent_runs">,
        | "created_at"
        | "finished_at"
        | "id"
        | "input_tokens"
        | "model_name"
        | "output_tokens"
        | "run_type"
        | "started_at"
        | "status"
        | "total_cost_usd"
      >
    >
  ).map((row) => ({
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    inputTokens: row.input_tokens,
    modelName: row.model_name,
    outputTokens: row.output_tokens,
    runType: row.run_type,
    startedAt: row.started_at,
    status: row.status,
    totalCostUsd: row.total_cost_usd,
  }));

  const session: SessionDetail = {
    archivedAt: sessionRow.archived_at,
    artifacts,
    createdAt: sessionRow.created_at,
    currentArtifactVersion: sessionRow.current_artifact_version,
    id: sessionRow.id,
    linearIssueId: sessionRow.linear_issue_id,
    linearIssueUrl: sessionRow.linear_issue_url,
    number: sessionRow.number,
    phase: sessionRow.phase as SessionPhase,
    phaseStatus: sessionRow.phase_status as SessionPhaseStatus,
    phaseCompletions,
    promptMd: sessionRow.prompt_md,
    pullRequestCount: pullRequests.length,
    pullRequests,
    rejectionCount: sessionRow.rejection_count,
    runHistory,
    slackChannelId: sessionRow.slack_channel_id,
    slackThreadTs: sessionRow.slack_thread_ts,
    title: sessionRow.title,
    updatedAt: sessionRow.updated_at,
    workspaceId: sessionRow.workspace_id,
  };

  const sessionGithubRepositoryId = prRowsTyped[0]?.github_repository_id ?? null;
  const repository = sessionGithubRepositoryId
    ? (repositoryIndex.get(sessionGithubRepositoryId) ?? null)
    : null;

  const wallie = await loadWallieIssueData({
    memberIndex: context.memberIndex,
    repository: repository
      ? {
          defaultBranch: repository.defaultBranch,
          defaultProgrammingLanguage: repository.defaultProgrammingLanguage,
          fullName: repository.fullName,
          htmlUrl: repository.htmlUrl,
          id: sessionGithubRepositoryId!,
          isArchived: repository.isArchived,
          isPrivate: repository.isPrivate,
        }
      : null,
    session: { githubRepositoryId: sessionGithubRepositoryId, id: sessionRow.id },
    supabase: context.supabase,
    workspaceId: context.workspace.id,
  });

  const sessionCreator = sessionRow.creator_member_id
    ? (context.memberIndex.get(sessionRow.creator_member_id) ?? null)
    : null;

  return {
    currentMember: context.currentMember,
    memberIndex: context.memberIndex,
    members: context.members,
    session,
    sessionGithubRepositoryId,
    sessionCreator,
    wallie,
    workspace: context.workspace,
  };
}
