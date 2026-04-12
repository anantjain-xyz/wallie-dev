import type { Enums, Json, Tables } from "@/lib/supabase/database.types";

// Minimal "issues" types kept for the wallie panel + session detail code
// paths that still consume the anchor issue row. The classical tracker
// (status / priority / estimate / assignee / plan / design / comments /
// links) was removed in PR 4; what's left is a thin envelope around the
// workspace-scoped issue row plus the workspace member type.

export type MemberKind = Enums<"member_kind">;
export type MemberRole = Enums<"member_role">;

export type IssueMember = {
  avatarUrl: string | null;
  fullName: string | null;
  id: string;
  isActive: boolean;
  kind: MemberKind;
  role: MemberRole;
  userId: string | null;
  username: string | null;
};

export type IssueViewerMember = IssueMember & {
  preferences: Json;
};

export type IssueDetail = {
  createdAt: string;
  creator: IssueMember | null;
  creatorMemberId: string | null;
  descriptionMd: string;
  githubRepositoryId: string | null;
  id: string;
  number: number;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type WorkspaceMemberRow = Pick<
  Tables<"workspace_members">,
  "avatar_url" | "full_name" | "id" | "is_active" | "kind" | "role" | "user_id" | "username"
>;

export type WorkspaceViewerMemberRow = WorkspaceMemberRow & {
  preferences: Json;
};

export function getIssueMemberDisplayName(member: IssueMember | null) {
  if (!member) {
    return "Unassigned";
  }

  return member.fullName ?? member.username ?? "Unknown member";
}

export function isWorkspaceManager(member: Pick<IssueMember, "role"> | null) {
  return member?.role === "owner" || member?.role === "admin";
}
