import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
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
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<CursorCredential> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new CursorNotConnectedError("Session has no human owner connected to Cursor.");
  }
  return getCursorCredentialForUser(admin, userId);
}

export async function getCursorCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<CursorCredential> {
  const { data, error } = await admin
    .from("user_cursor_credentials")
    .select("encrypted_api_key, api_key_expires_at, reconnect_required, reconnect_reason")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new CursorNotConnectedError(
      "Cursor is not connected. Ask the session owner to sign in with Cursor in Settings.",
    );
  }
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
    secret: decryptSecretValue(data.encrypted_api_key),
    userId,
  };
}

export async function markCursorReconnectRequired(
  admin: AdminClient,
  userId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("user_cursor_credentials")
    .update({ reconnect_reason: reason.slice(0, 500), reconnect_required: true })
    .eq("user_id", userId);
  if (error) throw error;
}
