import { z } from "zod";

import type { Tables } from "@/lib/supabase/database.types";

/**
 * Roles a manager is allowed to assign to another member. Ownership transfer is
 * deliberately out of scope, so `owner` is not assignable and the owner row is
 * never mutated by these routes.
 */
export const workspaceMemberAssignableRoleSchema = z.enum(["member", "admin"]);

export const workspaceMemberParamsSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export const workspaceMemberActionParamsSchema = workspaceMemberParamsSchema.extend({
  memberId: z.string().uuid("Member id is invalid."),
});

export const updateWorkspaceMemberRoleSchema = z.object({
  role: workspaceMemberAssignableRoleSchema,
});

export type WorkspaceMemberAssignableRole = z.infer<typeof workspaceMemberAssignableRoleSchema>;

export type WorkspaceMemberSummary = {
  email: string | null;
  fullName: string | null;
  id: string;
  role: Tables<"workspace_members">["role"];
};

export type WorkspaceMemberRow = Pick<
  Tables<"workspace_members">,
  "email" | "full_name" | "id" | "role"
>;

export type WorkspaceMemberResponse = {
  member: WorkspaceMemberSummary;
};

export function mapWorkspaceMemberSummaryRow(row: WorkspaceMemberRow): WorkspaceMemberSummary {
  return {
    email: row.email,
    fullName: row.full_name,
    id: row.id,
    role: row.role,
  };
}
