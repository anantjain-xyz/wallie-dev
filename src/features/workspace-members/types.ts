import type { Enums, Json, Tables } from "@/lib/supabase/database.types";

export type MemberKind = Enums<"member_kind">;
export type MemberRole = Enums<"member_role">;

export type WorkspaceMember = {
  avatarUrl: string | null;
  fullName: string | null;
  id: string;
  isActive: boolean;
  kind: MemberKind;
  role: MemberRole;
  userId: string | null;
  username: string | null;
};

export type WorkspaceViewerMember = WorkspaceMember & {
  preferences: Json;
};

export type WorkspaceMemberRow = Pick<
  Tables<"workspace_members">,
  "avatar_url" | "full_name" | "id" | "is_active" | "kind" | "role" | "user_id" | "username"
>;

export type WorkspaceViewerMemberRow = WorkspaceMemberRow & {
  preferences: Json;
};

export function getWorkspaceMemberDisplayName(member: WorkspaceMember | null) {
  if (!member) {
    return "Unassigned";
  }

  return member.fullName ?? member.username ?? "Unknown member";
}

export function isWorkspaceManager(member: Pick<WorkspaceMember, "role"> | null) {
  return member?.role === "owner" || member?.role === "admin";
}
