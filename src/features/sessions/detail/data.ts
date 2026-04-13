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

/**
 * Synthesize a minimal IssueDetail from a session row when no anchor issue
 * exists. This lets existing UI components that accept IssueDetail render
 * without changes.
 */
function synthesizeIssueFromSession(
  sessionRow: Pick<
    Tables<"sessions">,
    | "created_at"
    | "creator_member_id"
    | "id"
    | "number"
    | "prompt_md"
    | "title"
    | "updated_at"
    | "workspace_id"
  >,
  memberIndex: ReadonlyMap<string, IssueMember>,
): IssueDetail {
  return {
    createdAt: sessionRow.created_at,
    creator: sessionRow.creator_member_id
      ? (memberIndex.get(sessionRow.creator_member_id) ?? null)
      : null,
    creatorMemberId: sessionRow.creator_member_id,
    descriptionMd: sessionRow.prompt_md,
    githubRepositoryId: null,
    id: sessionRow.id,
    number: sessionRow.number,
    title: sessionRow.title,
    updatedAt: sessionRow.updated_at,
    workspaceId: sessionRow.workspace_id,
  };
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

  const { data: sessionRow, error: sessionError } = await context.supabase
    .from("sessions")
    .select(
      `
        id,
        archived_at,
        created_at,
        creator_member_id,
        updated_at,
        issue_id,
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

  // Load the anchor issue if one exists (legacy sessions have one). New
  // sessions created after the Phase 0 migration may omit the anchor issue
  // entirely. We synthesize a minimal IssueDetail from the session row so
  // existing UI components that expect an issue object still render.
  let issue: IssueDetail;
  let issueData: Tables<"issues"> | null = null;

  if (sessionRow.issue_id) {
    const { data, error: issueError } = await context.supabase
      .from("issues")
      .select("*")
      .eq("workspace_id", context.workspace.id)
      .eq("id", sessionRow.issue_id)
      .maybeSingle();

    if (issueError) {
      throw issueError;
    }

    if (data) {
      issueData = data as Tables<"issues">;
      issue = mapIssueDetailRow(issueData, context.memberIndex);
    } else {
      issue = synthesizeIssueFromSession(sessionRow, context.memberIndex);
    }
  } else {
    issue = synthesizeIssueFromSession(sessionRow, context.memberIndex);
  }

  // Build parallel queries. github_issue_branches and agent_runs are keyed
  // on issue_id — when there's no anchor issue we return empty arrays.
  const prQuery = sessionRow.issue_id
    ? context.supabase
        .from("github_issue_branches")
        .select(
          "id, github_repository_id, branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft, updated_at",
        )
        .eq("workspace_id", context.workspace.id)
        .eq("issue_id", sessionRow.issue_id)
        .order("created_at", { ascending: false })
    : Promise.resolve({ data: [] as never[], error: null });

  const runQuery = sessionRow.issue_id
    ? context.supabase
        .from("agent_runs")
        .select(
          "id, created_at, finished_at, input_tokens, model_name, output_tokens, run_type, started_at, status, total_cost_usd",
        )
        .eq("issue_id", sessionRow.issue_id)
        .order("created_at", { ascending: false })
        .limit(10)
    : Promise.resolve({ data: [] as never[], error: null });

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
    prQuery,
    runQuery,
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

  const repoIds = Array.from(
    new Set(
      ((prRows ?? []) as Array<{ github_repository_id: string | null }>)
        .map((row) => row.github_repository_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let repositoryIndex = new Map<string, { fullName: string; htmlUrl: string }>();
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

  const pullRequests: SessionPullRequest[] = (
    (prRows ?? []) as Array<
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
    >
  ).map((row) => {
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

  // Load wallie panel data only when an anchor issue exists. The wallie
  // panel queries agent_runs by issue_id and the "Run with Wallie" action
  // validates against the issues table, so passing a non-issue UUID would
  // cause query misses and "Issue not found" errors.
  let wallie: WallieIssueData;

  if (issueData) {
    const { data: repoForIssueData, error: repoForIssueError } = issueData.github_repository_id
      ? await context.supabase
          .from("github_repositories")
          .select(
            "id, full_name, html_url, private, default_programming_language, default_branch, is_archived",
          )
          .eq("id", issueData.github_repository_id)
          .maybeSingle()
      : { data: null, error: null };

    if (repoForIssueError) {
      throw repoForIssueError;
    }

    wallie = await loadWallieIssueData({
      issue: { github_repository_id: issueData.github_repository_id, id: issueData.id },
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
  } else {
    // No anchor issue — return an inert wallie state. The panel renders
    // but enqueue/retry are disabled and no runs are shown.
    wallie = {
      blockingReasons: [],
      canEnqueue: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
      requiredSecretKeys: [],
      runs: [],
    };
  }

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
