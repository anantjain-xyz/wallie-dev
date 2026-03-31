import "server-only";

import { notFound } from "next/navigation";

import type { WorkspaceSummary } from "@/lib/auth";
import type { Tables } from "@/lib/supabase/database.types";
import {
  mapIssueCommentRow,
  mapIssueDetailRow,
  mapIssueRow,
} from "@/features/issues/model";
import { loadIssueWorkspaceContext } from "@/features/issues/server";
import { groupIssueLinks } from "@/features/issues/detail/relationships";
import { loadWallieIssueData } from "@/features/wallie/server";
import type { WallieIssueData } from "@/features/wallie/types";
import type {
  IssueComment,
  IssueDetail,
  IssueMember,
  IssueSummary,
  IssueViewerMember,
} from "@/features/issues/types";

export type IssueDetailPageData = {
  comments: IssueComment[];
  currentMember: IssueViewerMember | null;
  github: {
    pullRequests: Array<{
      branchName: string;
      createdAt: string;
      githubRepositoryId: string | null;
      id: string;
      isDraft: boolean | null;
      pullRequestNumber: number | null;
      pullRequestState: string | null;
      pullRequestUrl: string | null;
      repository: {
        defaultBranch: string | null;
        defaultProgrammingLanguage: string | null;
        fullName: string;
        htmlUrl: string;
        id: string;
        isArchived: boolean;
        isPrivate: boolean;
      } | null;
      updatedAt: string;
    }>;
    repositories: Array<{
      defaultBranch: string | null;
      defaultProgrammingLanguage: string | null;
      fullName: string;
      htmlUrl: string;
      id: string;
      isArchived: boolean;
      isPrivate: boolean;
    }>;
  };
  issue: IssueDetail;
  linkedIssues: IssueSummary[];
  links: Tables<"issue_links">[];
  members: IssueMember[];
  relationshipGroups: ReturnType<typeof groupIssueLinks>;
  wallie: WallieIssueData;
  workspace: WorkspaceSummary;
};

export async function loadIssueDetailPageData(
  workspaceSlug: string,
  issueNumberValue: string,
) {
  const issueNumber = Number(issueNumberValue);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    notFound();
  }

  const context = await loadIssueWorkspaceContext(workspaceSlug);
  const { data: issueData, error: issueError } = await context.supabase
    .from("issues")
    .select("*")
    .eq("workspace_id", context.workspace.id)
    .eq("number", issueNumber)
    .maybeSingle();

  if (issueError) {
    throw issueError;
  }

  if (!issueData) {
    notFound();
  }

  const issue = mapIssueDetailRow(issueData as Tables<"issues">, context.memberIndex);
  const [
    { data: commentsData, error: commentsError },
    { data: linksData, error: linksError },
    { data: repositoryData, error: repositoryError },
    { data: pullRequestData, error: pullRequestError },
  ] = await Promise.all([
    context.supabase
      .from("issue_comments")
      .select("*")
      .eq("workspace_id", context.workspace.id)
      .eq("issue_id", issue.id)
      .order("created_at", { ascending: true }),
    context.supabase
      .from("issue_links")
      .select("*")
      .eq("workspace_id", context.workspace.id)
      .or(`source_issue_id.eq.${issue.id},target_issue_id.eq.${issue.id}`),
    context.supabase
      .from("github_repositories")
      .select(
        "id, full_name, html_url, private, default_programming_language, default_branch, is_archived",
      )
      .eq("workspace_id", context.workspace.id)
      .order("full_name", { ascending: true }),
    context.supabase
      .from("github_issue_branches")
      .select(
        "id, github_repository_id, branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft, created_at, updated_at",
      )
      .eq("workspace_id", context.workspace.id)
      .eq("issue_id", issue.id)
      .order("created_at", { ascending: false }),
  ]);

  if (commentsError) {
    throw commentsError;
  }

  if (linksError) {
    throw linksError;
  }

  if (repositoryError) {
    throw repositoryError;
  }

  if (pullRequestError) {
    throw pullRequestError;
  }

  const links = (linksData ?? []) as Tables<"issue_links">[];
  const githubRepositories = ((repositoryData ?? []) as Array<
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
  >).map((repository) => ({
    defaultBranch: repository.default_branch,
    defaultProgrammingLanguage: repository.default_programming_language,
    fullName: repository.full_name,
    htmlUrl: repository.html_url,
    id: repository.id,
    isArchived: repository.is_archived,
    isPrivate: repository.private,
  }));
  const githubRepositoryIndex = new Map(
    githubRepositories.map((repository) => [repository.id, repository]),
  );
  const wallie = await loadWallieIssueData({
    issue: issueData as Pick<Tables<"issues">, "github_repository_id" | "id">,
    memberIndex: context.memberIndex,
    repository: issue.githubRepositoryId
      ? githubRepositoryIndex.get(issue.githubRepositoryId) ?? null
      : null,
    supabase: context.supabase,
    workspaceId: context.workspace.id,
  });
  const linkedIssueIds = Array.from(
    new Set(
      links
        .flatMap((link) => [link.source_issue_id, link.target_issue_id])
        .filter((linkedIssueId) => linkedIssueId !== issue.id),
    ),
  );

  let linkedIssues: IssueSummary[] = [];

  if (linkedIssueIds.length > 0) {
    const { data: linkedIssuesData, error: linkedIssuesError } =
      await context.supabase
        .from("issues")
        .select("*")
        .in("id", linkedIssueIds);

    if (linkedIssuesError) {
      throw linkedIssuesError;
    }

    linkedIssues = ((linkedIssuesData ?? []) as Tables<"issues">[]).map(
      (linkedIssue) => mapIssueRow(linkedIssue, context.memberIndex),
    );
  }

  const linkedIssueIndex = new Map(
    linkedIssues.map((linkedIssue) => [linkedIssue.id, linkedIssue]),
  );

  return {
    comments: ((commentsData ?? []) as Tables<"issue_comments">[]).map(
      (comment) => mapIssueCommentRow(comment, context.memberIndex),
    ),
    currentMember: context.currentMember,
    github: {
      pullRequests: ((pullRequestData ?? []) as Array<
        Pick<
          Tables<"github_issue_branches">,
          | "branch_name"
          | "created_at"
          | "github_repository_id"
          | "id"
          | "is_draft"
          | "pull_request_number"
          | "pull_request_state"
          | "pull_request_url"
          | "updated_at"
        >
      >).map((pullRequest) => ({
        branchName: pullRequest.branch_name,
        createdAt: pullRequest.created_at,
        githubRepositoryId: pullRequest.github_repository_id,
        id: pullRequest.id,
        isDraft: pullRequest.is_draft,
        pullRequestNumber: pullRequest.pull_request_number,
        pullRequestState: pullRequest.pull_request_state,
        pullRequestUrl: pullRequest.pull_request_url,
        repository: pullRequest.github_repository_id
          ? githubRepositoryIndex.get(pullRequest.github_repository_id) ?? null
          : null,
        updatedAt: pullRequest.updated_at,
      })),
      repositories: githubRepositories,
    },
    issue,
    linkedIssues,
    links,
    members: context.members.filter((member) => member.isActive),
    relationshipGroups: groupIssueLinks(issue.id, links, linkedIssueIndex),
    wallie,
    workspace: context.workspace,
  } satisfies IssueDetailPageData;
}
