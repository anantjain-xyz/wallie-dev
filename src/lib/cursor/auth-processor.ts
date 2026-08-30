import "server-only";

import { randomUUID } from "node:crypto";

import { Cursor, DEFAULT_LOGIN_API_KEY_TTL_MS } from "@cursor/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

const POLL_INTERVAL_MS = 1_000;
const MAX_CONCURRENT_AUTH_FLOWS = 4;
export const CURSOR_AUTH_FLOW_LEASE_MS = 15_000;

export function createCursorAuthClaimToken(workerId: string): string {
  return `${workerId}:${randomUUID()}`;
}

type CursorAuthProcessorOptions = {
  concurrencyLimit?: number;
  pollIntervalMs?: number;
  processFlow?: typeof processNextCursorAuthFlow;
};

export function startCursorAuthProcessor(
  admin: AdminClient,
  workerId: string,
  options: CursorAuthProcessorOptions = {},
) {
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const concurrencyLimit = options.concurrencyLimit ?? MAX_CONCURRENT_AUTH_FLOWS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const processFlow = options.processFlow ?? processNextCursorAuthFlow;
  let stopped = false;

  const tick = () => {
    if (stopped || active.size >= concurrencyLimit) return;
    const controller = new AbortController();
    controllers.add(controller);
    const task = processFlow(admin, workerId, controller.signal)
      .then(() => undefined)
      .catch((error) => console.error("[cursor-auth] processor failed", { error }))
      .finally(() => {
        active.delete(task);
        controllers.delete(controller);
      });
    active.add(task);
  };

  const timer = setInterval(tick, pollIntervalMs);
  tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      await Promise.all(active);
    },
  };
}

export async function processNextCursorAuthFlow(
  admin: AdminClient,
  workerId: string,
  shutdownSignal?: AbortSignal,
): Promise<boolean> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const claimToken = createCursorAuthClaimToken(workerId);
  const { error: expirationError } = await admin
    .from("cursor_auth_flows")
    .update({ status: "expired" })
    .in("status", ["starting", "processing", "prompted"])
    .lt("expires_at", now);
  if (expirationError) throw expirationError;

  await reclaimStaleCursorAuthFlows(admin, nowMs);

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
    .update({ claimed_at: now, claimed_by: claimToken, status: "processing" })
    .eq("id", pending.id)
    .eq("status", "starting")
    .select("id, expires_at")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return false;

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Date.parse(claimed.expires_at) - Date.now());
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const claimHeartbeat = setInterval(() => {
    void admin
      .from("cursor_auth_flows")
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", claimed.id)
      .eq("claimed_by", claimToken)
      .in("status", ["processing", "prompted"])
      .select("id")
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && !data) controller.abort();
      });
  }, POLL_INTERVAL_MS);
  const onShutdown = () => controller.abort();
  if (shutdownSignal?.aborted) controller.abort();
  else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  try {
    const result = await Cursor.auth.login({
      apiKeyName: "Wallie",
      apiKeyTtlMs: DEFAULT_LOGIN_API_KEY_TTL_MS,
      onLoginUrl: (loginUrl) => {
        void admin
          .from("cursor_auth_flows")
          .update({ login_url: loginUrl, status: "prompted" })
          .eq("id", claimed.id)
          .eq("claimed_by", claimToken)
          .in("status", ["processing", "prompted"]);
      },
      openBrowser: false,
      signal: controller.signal,
      store: null,
    });

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(result.apiKeyExpiresAtMs).toISOString();
    await completeCursorAuthFlow(admin, {
      accountEmail: result.email ?? null,
      apiKeyExpiresAt: expiresAt,
      claimedBy: claimToken,
      completedAt,
      encryptedApiKey: encryptSecretValue(result.apiKey),
      flowId: claimed.id,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    if (shutdownSignal?.aborted) {
      await admin
        .from("cursor_auth_flows")
        .update({
          claimed_at: null,
          claimed_by: null,
          error_message: null,
          login_url: null,
          status: "starting",
        })
        .eq("id", claimed.id)
        .eq("claimed_by", claimToken)
        .in("status", ["processing", "prompted"]);
    } else {
      await admin
        .from("cursor_auth_flows")
        .update({
          error_message: aborted ? "Cursor sign-in expired." : errorMessage(error),
          status: aborted ? "expired" : "error",
        })
        .eq("id", claimed.id)
        .eq("claimed_by", claimToken)
        .in("status", ["processing", "prompted"]);
    }
  } finally {
    clearInterval(claimHeartbeat);
    clearTimeout(timeout);
    shutdownSignal?.removeEventListener("abort", onShutdown);
  }
  return true;
}

export async function completeCursorAuthFlow(
  admin: AdminClient,
  input: {
    accountEmail: string | null;
    apiKeyExpiresAt: string;
    claimedBy: string;
    completedAt: string;
    encryptedApiKey: string;
    flowId: string;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("complete_cursor_auth_flow", {
    p_account_email: input.accountEmail ?? undefined,
    p_api_key_expires_at: input.apiKeyExpiresAt,
    p_claimed_by: input.claimedBy,
    p_completed_at: input.completedAt,
    p_encrypted_api_key: input.encryptedApiKey,
    p_flow_id: input.flowId,
  });
  if (error) throw error;
  return data;
}

export async function reclaimStaleCursorAuthFlows(
  admin: AdminClient,
  nowMs = Date.now(),
): Promise<void> {
  const now = new Date(nowMs).toISOString();
  const leaseExpiredAt = new Date(nowMs - CURSOR_AUTH_FLOW_LEASE_MS).toISOString();
  const { error } = await admin
    .from("cursor_auth_flows")
    .update({
      claimed_at: null,
      claimed_by: null,
      error_message: null,
      login_url: null,
      status: "starting",
    })
    .in("status", ["processing", "prompted"])
    .lt("claimed_at", leaseExpiredAt)
    .gt("expires_at", now);
  if (error) throw error;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Cursor sign-in failed.").slice(0, 500);
}
