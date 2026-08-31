import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import type { OpenCodeCredential } from "@/lib/opencode/contracts";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export class OpenCodeNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeNotConnectedError";
  }
}

export async function getOpenCodeCredentialForSession(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<OpenCodeCredential> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new OpenCodeNotConnectedError(
      "Session has no human owner with a connected OpenCode Zen API key.",
    );
  }
  return getOpenCodeCredentialForUser(admin, userId);
}

export async function getOpenCodeCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<OpenCodeCredential> {
  const { data, error } = await admin
    .from("user_opencode_credentials")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new OpenCodeNotConnectedError(
      `OpenCode is not connected for user ${userId}. Ask the session owner to connect an OpenCode Zen API key in their profile.`,
    );
  }

  return {
    secret: decryptSecretValue(data.encrypted_api_key),
  };
}
