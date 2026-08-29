import "server-only";

import { Cursor, DEFAULT_LOGIN_API_KEY_TTL_MS } from "@cursor/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

const POLL_INTERVAL_MS = 1_000;

export function startCursorAuthProcessor(admin: AdminClient, workerId: string) {
  let active: Promise<void> | null = null;
  let stopped = false;
  let controller: AbortController | null = null;

  const tick = () => {
    if (stopped || active) return;
    controller = new AbortController();
    active = processNextCursorAuthFlow(admin, workerId, controller.signal)
      .then(() => undefined)
      .catch((error) => console.error("[cursor-auth] processor failed", { error }))
      .finally(() => {
        active = null;
        controller = null;
      });
  };

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
      await active;
    },
  };
}

export async function processNextCursorAuthFlow(
  admin: AdminClient,
  workerId: string,
  shutdownSignal?: AbortSignal,
): Promise<boolean> {
  const now = new Date().toISOString();
  await admin
    .from("cursor_auth_flows")
    .update({ status: "expired" })
    .in("status", ["starting", "processing", "prompted"])
    .lt("expires_at", now);

  const { data: pending, error: pendingError } = await admin
    .from("cursor_auth_flows")
    .select("id, expires_at")
    .eq("status", "starting")
    .gt("expires_at", now)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pendingError) throw pendingError;
  if (!pending) return false;

  const { data: claimed, error: claimError } = await admin
    .from("cursor_auth_flows")
    .update({ claimed_at: now, claimed_by: workerId, status: "processing" })
    .eq("id", pending.id)
    .eq("status", "starting")
    .select("id, user_id, expires_at")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return false;

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Date.parse(claimed.expires_at) - Date.now());
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancellationCheck = setInterval(() => {
    void admin
      .from("cursor_auth_flows")
      .select("status")
      .eq("id", claimed.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.status === "canceled") controller.abort();
      });
  }, POLL_INTERVAL_MS);
  const onShutdown = () => controller.abort();
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  try {
    const result = await Cursor.auth.login({
      apiKeyName: "Wallie",
      apiKeyTtlMs: DEFAULT_LOGIN_API_KEY_TTL_MS,
      onLoginUrl: (loginUrl) => {
        void admin
          .from("cursor_auth_flows")
          .update({ login_url: loginUrl, status: "prompted" })
          .eq("id", claimed.id)
          .in("status", ["processing", "prompted"]);
      },
      openBrowser: false,
      signal: controller.signal,
      store: null,
    });

    const { data: current } = await admin
      .from("cursor_auth_flows")
      .select("status")
      .eq("id", claimed.id)
      .maybeSingle();
    if (current?.status === "canceled") return true;

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(result.apiKeyExpiresAtMs).toISOString();
    const { error: credentialError } = await admin.from("user_cursor_credentials").upsert(
      {
        account_email: result.email ?? null,
        api_key_expires_at: expiresAt,
        encrypted_api_key: encryptSecretValue(result.apiKey),
        reconnect_reason: null,
        reconnect_required: false,
        updated_at: completedAt,
        user_id: claimed.user_id,
      },
      { onConflict: "user_id" },
    );
    if (credentialError) throw credentialError;

    const { error: flowError } = await admin
      .from("cursor_auth_flows")
      .update({ completed_at: completedAt, status: "authenticated" })
      .eq("id", claimed.id);
    if (flowError) throw flowError;
  } catch (error) {
    const aborted = controller.signal.aborted;
    await admin
      .from("cursor_auth_flows")
      .update({
        error_message: aborted
          ? "Cursor sign-in expired or the worker stopped."
          : errorMessage(error),
        status: aborted ? "expired" : "error",
      })
      .eq("id", claimed.id)
      .neq("status", "canceled");
  } finally {
    clearInterval(cancellationCheck);
    clearTimeout(timeout);
    shutdownSignal?.removeEventListener("abort", onShutdown);
  }
  return true;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Cursor sign-in failed.").slice(0, 500);
}
