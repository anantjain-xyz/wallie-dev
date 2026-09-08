import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

export const githubInstallCookieName = "wallie-github-install";
export const githubInstallFlowLifetimeSeconds = 10 * 60;
export type GitHubInstallFlow = Tables<"github_install_flows">;

export function githubInstallCookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    maxAge: githubInstallFlowLifetimeSeconds,
    path: "/api/github",
    sameSite: "lax" as const,
    secure: new URL(appUrl).protocol === "https:",
  };
}

export function hashGitHubState(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function githubCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function matchesGitHubStateCookie(
  state: string | null | undefined,
  cookie: string | null | undefined,
): state is string {
  return Boolean(
    state &&
    cookie &&
    /^[A-Za-z0-9_-]{43}$/.test(state) &&
    /^[A-Za-z0-9_-]{43}$/.test(cookie) &&
    timingSafeEqual(Buffer.from(state), Buffer.from(cookie)),
  );
}

export async function createGitHubInstallFlow(input: {
  source: "onboarding" | "settings";
  userId: string;
  workspaceId: string;
}) {
  const admin = createSupabaseAdminClient();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const now = Date.now();
  const { error: cleanupError } = await admin
    .from("github_install_flows")
    .delete()
    .eq("user_id", input.userId)
    .lt("expires_at", new Date(now).toISOString());
  if (cleanupError) throw cleanupError;

  const { error } = await admin.from("github_install_flows").insert({
    encrypted_code_verifier: encryptSecretValue(verifier),
    expires_at: new Date(now + githubInstallFlowLifetimeSeconds * 1000).toISOString(),
    source: input.source,
    state_hash: hashGitHubState(state),
    user_id: input.userId,
    workspace_id: input.workspaceId,
  });
  if (error) throw error;
  return state;
}

export async function loadGitHubInstallFlow(state: string, userId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_install_flows")
    .select("*")
    .eq("state_hash", hashGitHubState(state))
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function advanceGitHubInstallFlow(flow: GitHubInstallFlow, installationId: number) {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_install_flows")
    .update({ installation_id: installationId, phase: "authorize" })
    .eq("state_hash", flow.state_hash)
    .eq("user_id", flow.user_id)
    .eq("workspace_id", flow.workspace_id)
    .eq("phase", "install")
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function consumeGitHubInstallFlow(flow: GitHubInstallFlow) {
  if (flow.installation_id === null) return false;
  const { data, error } = await createSupabaseAdminClient()
    .from("github_install_flows")
    .delete()
    .eq("state_hash", flow.state_hash)
    .eq("user_id", flow.user_id)
    .eq("workspace_id", flow.workspace_id)
    .eq("phase", "authorize")
    .eq("installation_id", flow.installation_id)
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
