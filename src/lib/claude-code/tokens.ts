import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionCredentialOwner } from "@/lib/agent-credentials/session-owner";
import type { ClaudeCodeCredential } from "@/lib/claude-code/contracts";
import type { Database } from "@/lib/supabase/database.types";
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
  session: SessionCredentialOwner,
): Promise<ClaudeCodeCredential> {
  const notConnected = () =>
    new ClaudeCodeNotConnectedError(
      "Session has no active human owner in this workspace with a connected Anthropic API key.",
    );
  if (!session.creator_member_id) throw notConnected();
  const { data, error } = await admin.rpc("load_session_claude_code_credential", {
    p_creator_member_id: session.creator_member_id,
    p_workspace_id: session.workspace_id,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw notConnected();
  return { secret: decryptSecretValue(row.encrypted_api_key) };
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
