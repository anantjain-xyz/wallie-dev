import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
export type InvitationSnapshot = Tables<"workspace_invitations">;
type InvitationFields = Pick<
  InvitationSnapshot,
  "expires_at" | "full_name" | "invited_by_member_id" | "last_sent_at" | "role" | "token_hash"
>;

export const invitationSelect =
  "id, workspace_id, email, full_name, role, status, token_hash, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at";

/** A token rotation owns only the pending version that it actually read. */
export async function saveInvitationForDelivery(input: {
  admin: Admin;
  email: string;
  fields: InvitationFields;
  previous: InvitationSnapshot | null;
  workspaceId: string;
}): Promise<InvitationSnapshot | null> {
  const { admin, previous } = input;
  const { data, error } = previous
    ? await admin
        .from("workspace_invitations")
        .update(input.fields)
        .eq("id", previous.id)
        .eq("workspace_id", input.workspaceId)
        .eq("status", "pending")
        .eq("token_hash", previous.token_hash)
        .select(invitationSelect)
        .maybeSingle()
    : await admin
        .from("workspace_invitations")
        .insert({
          ...input.fields,
          email: input.email,
          status: "pending",
          workspace_id: input.workspaceId,
        })
        .select(invitationSelect)
        .single();

  // Another create can win the unique pending-email constraint after our read.
  if (error?.code === "23505") return null;
  if (error) throw error;
  return data;
}

/** Failed delivery cannot undo a newer resend, acceptance, or revocation. */
export async function undoInvitationDelivery(input: {
  admin: Admin;
  previous: InvitationSnapshot | null;
  saved: InvitationSnapshot;
}): Promise<void> {
  const { admin, previous, saved } = input;
  const table = admin.from("workspace_invitations");
  const mutation = previous
    ? table.update({
        expires_at: previous.expires_at,
        full_name: previous.full_name,
        invited_by_member_id: previous.invited_by_member_id,
        last_sent_at: previous.last_sent_at,
        role: previous.role,
        token_hash: previous.token_hash,
      })
    : table.delete();
  const { error } = await mutation
    .eq("id", saved.id)
    .eq("workspace_id", saved.workspace_id)
    .eq("status", "pending")
    .eq("token_hash", saved.token_hash);
  if (error) throw error;
}
