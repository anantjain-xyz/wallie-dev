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
