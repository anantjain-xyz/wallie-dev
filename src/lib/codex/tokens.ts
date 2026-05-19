import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import type { CodexCredential, CodexCredentialType } from "@/lib/codex/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { decryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

export class CodexNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNotConnectedError";
  }
}

/**
 * Resolve a Codex credential for the user who created the session.
 * Throws CodexNotConnectedError when the session has no human owner or the
 * owner has not connected Codex.
 */
export async function getCodexCredentialForSession(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<CodexCredential> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new CodexNotConnectedError(
      "Session has no human owner with a connected Codex credential.",
    );
  }
  return getCodexCredentialForUser(admin, userId);
}

/**
 * Return a valid Codex credential for the given user. Throws
 * CodexNotConnectedError if the user has not connected Codex or if the saved
 * credential has expired.
 */
export async function getCodexCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<CodexCredential> {
  const { data, error } = await admin
    .from("user_codex_credentials")
    .select("credential_type, encrypted_credential, access_token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new CodexNotConnectedError(
      `Codex is not connected for user ${userId}. Ask the session owner to connect a Codex credential in their profile.`,
    );
  }

  const credentialType = data.credential_type as CodexCredentialType;
  const expiresAt = data.access_token_expires_at;
  if (expiresAt) {
    const expiresAtMs = new Date(expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      throw new CodexNotConnectedError(
        "The saved Codex credential has expired. Update the Codex credential in Settings.",
      );
    }
  }

  return {
    expiresAt,
    secret: decryptSecretValue(data.encrypted_credential),
    type: credentialType,
  };
}
