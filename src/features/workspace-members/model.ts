import type {
  WorkspaceMember,
  WorkspaceMemberRow,
  WorkspaceViewerMember,
  WorkspaceViewerMemberRow,
} from "@/features/workspace-members/types";

export function mapWorkspaceMemberRow(row: WorkspaceMemberRow): WorkspaceMember {
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

export function mapWorkspaceViewerMemberRow(row: WorkspaceViewerMemberRow): WorkspaceViewerMember {
  return {
    ...mapWorkspaceMemberRow(row),
    preferences: row.preferences,
  };
}

export function buildWorkspaceMemberIndex(members: readonly WorkspaceMember[]) {
  return new Map(members.map((member) => [member.id, member]));
}
