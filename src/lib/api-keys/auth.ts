import "server-only";

import { createHash } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export interface ApiKeyContext {
  apiKeyId: string;
  workspaceId: string;
}

/**
 * Hash a raw API key for storage/lookup. Uses SHA-256.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Generate a new API key with a workspace-identifying prefix.
 * Format: wk_<random 32 hex chars>
 */
export function generateApiKey(): { keyHash: string; keyPrefix: string; rawKey: string } {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rawKey = `wk_${hex}`;
  const keyPrefix = rawKey.slice(0, 7);
  const keyHash = hashApiKey(rawKey);

  return { keyHash, keyPrefix, rawKey };
}

/**
 * Authenticate a request using a workspace API key from the Authorization
 * header. Returns the workspace context if the key is valid and not revoked.
 *
 * Expected header format: `Authorization: Bearer wk_<hex>`
 */
export async function authenticateApiKey(request: Request): Promise<ApiKeyContext | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(wk_[a-f0-9]+)$/i);
  if (!match) return null;

  const rawKey = match[1]!;
  const keyHash = hashApiKey(rawKey);

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_api_keys")
    .select("id, workspace_id")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return null;

  // Touch last_used_at (fire-and-forget, non-blocking).
  void admin
    .from("workspace_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    apiKeyId: data.id,
    workspaceId: data.workspace_id,
  };
}
