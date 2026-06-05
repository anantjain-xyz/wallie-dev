import { z } from "zod";

import type { Enums, Tables } from "@/lib/supabase/database.types";

export const WORKSPACE_INVITATION_EXPIRES_DAYS = 7;

export const workspaceInvitationRoleSchema = z.enum(["member", "admin"]);

export const workspaceInvitationParamsSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export const workspaceInvitationActionParamsSchema = workspaceInvitationParamsSchema.extend({
  invitationId: z.string().uuid("Invitation id is invalid."),
});

export function normalizeWorkspaceInvitationEmail(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export const createWorkspaceInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .transform(normalizeWorkspaceInvitationEmail),
  role: workspaceInvitationRoleSchema.default("member"),
});

export type WorkspaceInvitationRole = z.infer<typeof workspaceInvitationRoleSchema>;
export type WorkspaceInvitationStatus = Enums<"workspace_invitation_status">;

export type WorkspaceInvitation = {
  acceptedAt: string | null;
  acceptedByMemberId: string | null;
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedByMemberId: string | null;
  lastSentAt: string | null;
  revokedAt: string | null;
  role: WorkspaceInvitationRole;
  status: WorkspaceInvitationStatus;
  updatedAt: string;
  workspaceId: string;
};

export type WorkspaceInvitationRow = Pick<
  Tables<"workspace_invitations">,
  | "accepted_at"
  | "accepted_by_member_id"
  | "created_at"
  | "email"
  | "expires_at"
  | "id"
  | "invited_by_member_id"
  | "last_sent_at"
  | "revoked_at"
  | "role"
  | "status"
  | "updated_at"
  | "workspace_id"
>;

export type WorkspaceInvitationResponse = {
  invitation: WorkspaceInvitation;
};

export type ListWorkspaceInvitationsResponse = {
  invitations: WorkspaceInvitation[];
};

export function mapWorkspaceInvitationRow(row: WorkspaceInvitationRow): WorkspaceInvitation {
  return {
    acceptedAt: row.accepted_at,
    acceptedByMemberId: row.accepted_by_member_id,
    createdAt: row.created_at,
    email: row.email,
    expiresAt: row.expires_at,
    id: row.id,
    invitedByMemberId: row.invited_by_member_id,
    lastSentAt: row.last_sent_at,
    revokedAt: row.revoked_at,
    role: workspaceInvitationRoleSchema.parse(row.role),
    status: row.status,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}
