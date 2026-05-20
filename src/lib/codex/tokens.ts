import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import {
  isCodexCredentialType,
  type ChatGptCodexCredential,
  type CodexChatGptAuthStore,
  type CodexCredential,
  type CodexCredentialType,
} from "@/lib/codex/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

type CodexCredentialRow = {
  access_token_expires_at: string | null;
  auth_cache_last_refresh: string | null;
  auth_reconnect_reason: string | null;
  auth_reconnect_required: boolean;
  credential_type: string;
  credential_version: number;
  encrypted_credential: string;
};

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
 * credential has expired or needs a fresh ChatGPT sign-in.
 */
export async function getCodexCredentialForUser(
  admin: AdminClient,
  userId: string,
): Promise<CodexCredential> {
  const { data, error } = await admin
    .from("user_codex_credentials")
    .select(
      "credential_type, encrypted_credential, access_token_expires_at, credential_version, auth_cache_last_refresh, auth_reconnect_required, auth_reconnect_reason",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new CodexNotConnectedError(
      `Codex is not connected for user ${userId}. Ask the session owner to connect a Codex credential in their profile.`,
    );
  }

  return mapCredentialRow(userId, data as CodexCredentialRow);
}

export function createCodexChatGptAuthStore(admin: AdminClient): CodexChatGptAuthStore {
  return {
    async acquireChatGptAuthLease(input) {
      const { data, error } = await admin.rpc("acquire_codex_auth_lease", {
        lease_expires_at: input.leaseExpiresAt,
        target_run_id: input.runId,
        target_user_id: input.userId,
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : null;
      return row
        ? (mapCredentialRow(input.userId, row as CodexCredentialRow) as ChatGptCodexCredential)
        : null;
    },

    async markChatGptAuthReconnectRequired(input) {
      const { error } = await admin.rpc("mark_codex_auth_reconnect_required", {
        reconnect_reason: input.reason,
        target_run_id: input.runId,
        target_user_id: input.userId,
      });
      if (error) throw error;
    },

    async persistChatGptAuthJson(input) {
      const { data, error } = await admin.rpc("persist_codex_auth_json", {
        new_account_email: input.metadata.accountEmail as string,
        new_account_id: input.metadata.accountId as string,
        new_auth_cache_last_refresh: input.metadata.lastRefresh as string,
        new_encrypted_credential: encryptSecretValue(input.authJson),
        previous_credential_version: input.previousCredentialVersion,
        target_run_id: input.runId,
        target_user_id: input.userId,
      });
      if (error) throw error;

      return Array.isArray(data) ? data.length > 0 : Boolean(data);
    },

    async releaseChatGptAuthLease(input) {
      const { error } = await admin.rpc("release_codex_auth_lease", {
        target_run_id: input.runId,
        target_user_id: input.userId,
      });
      if (error) throw error;
    },
  };
}

function mapCredentialRow(userId: string, row: CodexCredentialRow): CodexCredential {
  if (!isCodexCredentialType(row.credential_type)) {
    throw new CodexNotConnectedError("The saved Codex credential type is not supported.");
  }

  const credentialType = row.credential_type as CodexCredentialType;
  const expiresAt = row.access_token_expires_at;
  if (expiresAt) {
    const expiresAtMs = new Date(expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      throw new CodexNotConnectedError(
        "The saved Codex credential has expired. Update the Codex credential in Settings.",
      );
    }
  }

  if (credentialType === "chatgpt_auth_json" && row.auth_reconnect_required) {
    throw new CodexNotConnectedError(
      row.auth_reconnect_reason ??
        "The saved ChatGPT Codex sign-in needs to be refreshed. Reconnect Codex in Settings.",
    );
  }

  const secret = decryptSecretValue(row.encrypted_credential);

  switch (credentialType) {
    case "chatgpt_auth_json":
      return {
        authCacheLastRefresh: row.auth_cache_last_refresh,
        credentialVersion: row.credential_version,
        expiresAt: null,
        reconnectReason: row.auth_reconnect_reason,
        reconnectRequired: row.auth_reconnect_required,
        secret,
        type: "chatgpt_auth_json",
        userId,
      };
    case "codex_access_token":
      return {
        expiresAt,
        secret,
        type: "codex_access_token",
        userId,
      };
    case "platform_api_key":
      return {
        expiresAt: null,
        secret,
        type: "platform_api_key",
        userId,
      };
  }
}
