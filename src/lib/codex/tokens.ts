import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { refreshAccessToken } from "@/lib/codex/oauth";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

export class CodexNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNotConnectedError";
  }
}

/**
 * Resolve the session owner's auth.uid so we can look up their Codex tokens.
 * Sessions carry creator_member_id, which joins to workspace_members.user_id.
 */
export async function resolveSessionOwnerUserId(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<string | null> {
  if (!session.creator_member_id) return null;
  const { data, error } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("id", session.creator_member_id)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

/**
 * Resolve a fresh Codex access token for the user who created the session.
 * Throws CodexNotConnectedError when the session has no human owner or the
 * owner has not connected Codex.
 */
export async function getCodexAccessTokenForSession(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<string> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new CodexNotConnectedError("Session has no human owner with a connected Codex account.");
  }
  return getCodexAccessTokenForUser(admin, userId);
}

/** Refresh the token if it expires within this many ms from now. */
const REFRESH_LEEWAY_MS = 60_000;

/**
 * Return a valid Codex access token for the given user, refreshing it first
 * if it is near expiry. Throws CodexNotConnectedError if the user has not
 * connected Codex.
 */
export async function getCodexAccessTokenForUser(
  admin: AdminClient,
  userId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("user_codex_credentials")
    .select("encrypted_access_token, encrypted_refresh_token, access_token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new CodexNotConnectedError(
      `Codex is not connected for user ${userId}. Ask the session owner to connect Codex in their profile.`,
    );
  }

  const expiresAt = new Date(data.access_token_expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return decryptSecretValue(data.encrypted_access_token);
  }

  const refreshToken = decryptSecretValue(data.encrypted_refresh_token);
  const refreshed = await refreshAccessToken(refreshToken);

  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const { error: updateError } = await admin
    .from("user_codex_credentials")
    .update({
      encrypted_access_token: encryptSecretValue(refreshed.access_token),
      encrypted_refresh_token: encryptSecretValue(refreshed.refresh_token),
      access_token_expires_at: newExpiresAt,
      scope: refreshed.scope ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw updateError;

  return refreshed.access_token;
}
