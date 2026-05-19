import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import type { ClaudeCodeCredential } from "@/lib/claude-code/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { decryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

export class ClaudeCodeNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeNotConnectedError";
  }
}

export async function getClaudeCodeCredentialForSession(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
): Promise<ClaudeCodeCredential> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new ClaudeCodeNotConnectedError(
      "Session has no human owner with a connected Anthropic API key.",
    );
  }
  return getClaudeCodeCredentialForUser(admin, userId);
}

export async function getClaudeCodeCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<ClaudeCodeCredential> {
  const { data, error } = await admin
    .from("user_claude_code_credentials")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new ClaudeCodeNotConnectedError(
      `Claude Code is not connected for user ${userId}. Ask the session owner to connect an Anthropic API key in their profile.`,
    );
  }

  return {
    secret: decryptSecretValue(data.encrypted_api_key),
  };
}
