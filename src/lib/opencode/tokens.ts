import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import { OPENCODE_ZEN_PROVIDER_ID, parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import type {
  OpenCodeAuth,
  OpenCodeCredential,
  OpenCodeProviderCredentialMeta,
} from "@/lib/opencode/contracts";
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
  const credential = await loadZenCredential(admin, userId);
  if (!credential) {
    throw new OpenCodeNotConnectedError(
      `OpenCode is not connected for user ${userId}. Ask the session owner to connect an OpenCode Zen API key in their profile.`,
    );
  }
  return credential;
}

export async function getOpenCodeAuthForSession(
  admin: AdminClient,
  session: Pick<Tables<"sessions">, "creator_member_id">,
  model: string,
): Promise<OpenCodeAuth> {
  const userId = await resolveSessionOwnerUserId(admin, session);
  if (!userId) {
    throw new OpenCodeNotConnectedError(
      "Session has no human owner with a connected OpenCode API key.",
    );
  }
  return getOpenCodeAuthForUser(admin, userId, model);
}

export async function getOpenCodeAuthForUser(
  admin: AdminClient,
  userId: string,
  model: string,
): Promise<OpenCodeAuth> {
  const parsed = parseOpenCodeModelId(model);
  if (!parsed) {
    throw new OpenCodeNotConnectedError(
      `OpenCode model "${model}" is not a valid "<provider-id>/<model-id>" identifier.`,
    );
  }

  if (parsed.providerId === OPENCODE_ZEN_PROVIDER_ID) {
    const credential = await getOpenCodeCredentialForUser(admin, userId);
    return { credential, providerCredentials: {} };
  }

  const [credential, providerCredential] = await Promise.all([
    loadZenCredential(admin, userId),
    loadProviderCredential(admin, userId, parsed.providerId),
  ]);

  if (!providerCredential) {
    throw new OpenCodeNotConnectedError(
      `OpenCode provider "${parsed.providerId}" is not connected for user ${userId}. Ask the session owner to add an API key for "${parsed.providerId}" in Settings.`,
    );
  }

  return {
    credential,
    providerCredentials: { [parsed.providerId]: providerCredential },
  };
}

export async function listOpenCodeProviderCredentialMeta(
  admin: AdminClient,
  userId: string,
): Promise<OpenCodeProviderCredentialMeta[]> {
  const { data, error } = await admin
    .from("user_opencode_provider_credentials")
    .select("provider_id, updated_at")
    .eq("user_id", userId)
    .order("provider_id", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    providerId: row.provider_id,
    updatedAt: row.updated_at,
  }));
}

async function loadZenCredential(
  admin: AdminClient,
  userId: string,
): Promise<OpenCodeCredential | null> {
  const { data, error } = await admin
    .from("user_opencode_credentials")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { secret: decryptSecretValue(data.encrypted_api_key) };
}

async function loadProviderCredential(
  admin: AdminClient,
  userId: string,
  providerId: string,
): Promise<OpenCodeCredential | null> {
  const { data, error } = await admin
    .from("user_opencode_provider_credentials")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .eq("provider_id", providerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { secret: decryptSecretValue(data.encrypted_api_key) };
}
