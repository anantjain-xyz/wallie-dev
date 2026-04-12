import type { Tables } from "@/lib/supabase/database.types";

import type {
  IssueDetail,
  IssueMember,
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

export function mapIssueViewerMemberRow(row: WorkspaceViewerMemberRow): IssueViewerMember {
  return {
    ...mapIssueMemberRow(row),
    preferences: row.preferences,
  };
}

export function buildIssueMemberIndex(members: readonly IssueMember[]) {
  return new Map(members.map((member) => [member.id, member]));
}

export function mapIssueDetailRow(
  row: Tables<"issues">,
  memberIndex: ReadonlyMap<string, IssueMember>,
): IssueDetail {
  return {
    createdAt: row.created_at,
    creator: row.creator_member_id ? (memberIndex.get(row.creator_member_id) ?? null) : null,
    creatorMemberId: row.creator_member_id,
    descriptionMd: row.description_md,
    githubRepositoryId: row.github_repository_id,
    id: row.id,
    number: row.number,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}
