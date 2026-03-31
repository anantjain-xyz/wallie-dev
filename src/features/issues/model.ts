import type { Tables } from "@/lib/supabase/database.types";

import type {
  IssueComment,
  IssueDetail,
  IssueMember,
  IssueSummary,
  IssueViewerMember,
  WorkspaceMemberRow,
  WorkspaceViewerMemberRow,
} from "@/features/issues/types";

export function mapIssueMemberRow(row: WorkspaceMemberRow): IssueMember {
  return {
    avatarUrl: row.avatar_url,
    fullName: row.full_name,
    id: row.id,
    isActive: row.is_active,
    kind: row.kind,
    role: row.role,
    userId: row.user_id,
    username: row.username,
  };
}

export function mapIssueViewerMemberRow(
  row: WorkspaceViewerMemberRow,
): IssueViewerMember {
  return {
    ...mapIssueMemberRow(row),
    preferences: row.preferences,
  };
}

export function buildIssueMemberIndex(members: readonly IssueMember[]) {
  return new Map(members.map((member) => [member.id, member]));
}

export function mapIssueRow(
  row: Tables<"issues">,
  memberIndex: ReadonlyMap<string, IssueMember>,
): IssueSummary {
  return {
    assignee: row.assignee_member_id
      ? memberIndex.get(row.assignee_member_id) ?? null
      : null,
    assigneeMemberId: row.assignee_member_id,
    createdAt: row.created_at,
    creator: row.creator_member_id
      ? memberIndex.get(row.creator_member_id) ?? null
      : null,
    creatorMemberId: row.creator_member_id,
    descriptionMd: row.description_md,
    estimatePoints: row.estimate_points,
    githubRepositoryId: row.github_repository_id,
    id: row.id,
    number: row.number,
    priority: row.priority,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

export function mapIssueDetailRow(
  row: Tables<"issues">,
  memberIndex: ReadonlyMap<string, IssueMember>,
): IssueDetail {
  return {
    ...mapIssueRow(row, memberIndex),
    designMd: row.design_md,
    planMd: row.plan_md,
  };
}

export function mapIssueCommentRow(
  row: Tables<"issue_comments">,
  memberIndex: ReadonlyMap<string, IssueMember>,
): IssueComment {
  return {
    author: row.author_member_id
      ? memberIndex.get(row.author_member_id) ?? null
      : null,
    authorMemberId: row.author_member_id,
    bodyMd: row.body_md,
    createdAt: row.created_at,
    id: row.id,
    issueId: row.issue_id,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

export function mapIssueSummaryFromDetail(issue: IssueDetail): IssueSummary {
  return {
    assignee: issue.assignee,
    assigneeMemberId: issue.assigneeMemberId,
    createdAt: issue.createdAt,
    creator: issue.creator,
    creatorMemberId: issue.creatorMemberId,
    descriptionMd: issue.descriptionMd,
    estimatePoints: issue.estimatePoints,
    githubRepositoryId: issue.githubRepositoryId,
    id: issue.id,
    number: issue.number,
    priority: issue.priority,
    status: issue.status,
    title: issue.title,
    updatedAt: issue.updatedAt,
    workspaceId: issue.workspaceId,
  };
}
