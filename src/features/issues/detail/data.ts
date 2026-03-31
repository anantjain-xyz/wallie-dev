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
  issue: IssueDetail;
  linkedIssues: IssueSummary[];
  links: Tables<"issue_links">[];
  members: IssueMember[];
  relationshipGroups: ReturnType<typeof groupIssueLinks>;
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
  ]);

  if (commentsError) {
    throw commentsError;
  }

  if (linksError) {
    throw linksError;
  }

  const links = (linksData ?? []) as Tables<"issue_links">[];
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
    issue,
    linkedIssues,
    links,
    members: context.members.filter((member) => member.isActive),
    relationshipGroups: groupIssueLinks(issue.id, links, linkedIssueIndex),
    workspace: context.workspace,
  } satisfies IssueDetailPageData;
}
