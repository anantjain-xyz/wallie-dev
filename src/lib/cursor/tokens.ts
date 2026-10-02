import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionCredentialOwner } from "@/lib/agent-credentials/session-owner";
import type { CursorCredential } from "@/lib/cursor/contracts";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export class CursorNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorNotConnectedError";
  }
}

export async function getCursorCredentialForSession(
  admin: AdminClient,
  session: SessionCredentialOwner,
): Promise<CursorCredential> {
  const notConnected = () =>
    new CursorNotConnectedError(
      "Session has no active human owner in this workspace connected to Cursor.",
    );
  if (!session.creator_member_id) throw notConnected();
  const { data, error } = await admin.rpc("load_session_cursor_credential", {
    p_creator_member_id: session.creator_member_id,
    p_workspace_id: session.workspace_id,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw notConnected();
  return mapCredentialRow(row.user_id, row);
}

export async function getCursorCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<CursorCredential> {
  const { data, error } = await admin
    .from("user_cursor_credentials")
    .select(
      "credential_generation, encrypted_api_key, api_key_expires_at, reconnect_required, reconnect_reason",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new CursorNotConnectedError(
      "Cursor is not connected. Ask the session owner to sign in with Cursor in Settings.",
    );
  }
  return mapCredentialRow(userId, data);
}

function mapCredentialRow(
  userId: string,
  data: Pick<
    Tables<"user_cursor_credentials">,
    | "reconnect_required"
    | "reconnect_reason"
    | "api_key_expires_at"
    | "credential_generation"
    | "encrypted_api_key"
  >,
): CursorCredential {
  if (data.reconnect_required) {
    throw new CursorNotConnectedError(
      data.reconnect_reason ?? "Cursor needs to be reconnected in Settings.",
    );
  }
  if (Date.parse(data.api_key_expires_at) <= Date.now()) {
    throw new CursorNotConnectedError(
      "The Cursor connection expired. Reconnect Cursor in Settings.",
    );
  }

  return {
    expiresAt: data.api_key_expires_at,
    generation: data.credential_generation,
    secret: decryptSecretValue(data.encrypted_api_key),
    userId,
  };
}

export async function markCursorReconnectRequired(
  admin: AdminClient,
  userId: string,
  generation: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("user_cursor_credentials")
    .update({ reconnect_reason: reason.slice(0, 500), reconnect_required: true })
    .eq("user_id", userId)
    .eq("credential_generation", generation);
  if (error) throw error;
}
