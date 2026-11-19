import "server-only";

import { createHmac } from "node:crypto";
import { z } from "zod";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { postToFactoryEventDestination, type FactoryEventTransportResult } from "./transport";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const rpcTimeoutMs = 4_000;
const lastClaimStartMs = 30_000;
const batchRounds = 6;
const dispatchConcurrency = 4;
const eventIdentity = z
  .object({
    version: z.literal(1),
    eventId: z.string().uuid(),
    type: z.string().regex(/^[a-z][a-z_.]{1,63}$/),
  })
  .passthrough();

function retryAfterSeconds(value: string | undefined) {
  if (!value) return;
  const seconds = /^\d{1,8}$/.test(value)
    ? Number(value)
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.ceil((Date.parse(value) - Date.now()) / 1_000)
      : NaN;
  if (Number.isFinite(seconds)) return Math.min(3_600, Math.max(1, seconds));
}

type DeliverySettlement = {
  outcome: "delivered" | "retryable_failure" | "permanent_failure" | "unknown";
  httpStatus?: number;
  retryAfter?: number;
};

function deliverySettlement(
  result: Exclude<FactoryEventTransportResult, { kind: "skipped" }>,
): DeliverySettlement {
  if (result.kind === "rejected") return { outcome: "permanent_failure" };
  if (result.kind === "unavailable") return { outcome: "retryable_failure" };
  if (result.kind !== "response") return { outcome: "unknown" };
  const { status: httpStatus } = result;
  if (httpStatus >= 200 && httpStatus < 300) return { outcome: "delivered", httpStatus };
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return {
      outcome: "retryable_failure",
      httpStatus,
      retryAfter: retryAfterSeconds(result.retryAfter),
    };
  }
  return { outcome: "permanent_failure", httpStatus };
}

function signedMessage({
  secret,
  event,
}: {
  secret: string;
  event: z.infer<typeof eventIdentity>;
}) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${event.eventId}.`)
    .update(body)
    .digest("hex");
  return {
    body,
    headers: {
      "Wallie-Event-Id": event.eventId,
      "Wallie-Event-Type": event.type,
      "Wallie-Signature": `t=${timestamp},v1=${signature}`,
    },
  };
}

async function dispatchOne(admin: AdminClient) {
  const { data: claim, error: claimError } = await admin
    .rpc("claim_factory_event_delivery")
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs))
    .maybeSingle();
  if (claimError) throw new Error("Could not claim a factory event delivery.");
  if (!claim) return false;

  const identity = { p_delivery_id: claim.delivery_id, p_lease_id: claim.lease_id };
  let attemptId: string | undefined;
  const result = await postToFactoryEventDestination({
    url: claim.endpoint_url,
    prepare: async (signal) => {
      const { data: permission, error } = await admin
        .rpc("begin_factory_event_send", {
          ...identity,
          p_subscription_revision: claim.subscription_revision,
        })
        .abortSignal(signal)
        .single();
      if (error || !permission) {
        // An acknowledgement may have been lost after the permit committed.
        // Expiry recovery owns this uncertain transition.
        throw new Error("Could not confirm a factory event send permit.");
      }
      if (permission.outcome !== "authorized") return null;
      const event = eventIdentity.safeParse(permission.payload);
      if (
        !permission.attempt_id ||
        !permission.signing_secret_encrypted ||
        !event.success ||
        event.data.eventId !== permission.event_id ||
        event.data.type !== permission.event_type
      ) {
        throw new Error("Invalid factory event send permit.");
      }
      attemptId = permission.attempt_id;
      let secret: string;
      try {
        secret = decryptSecretValue(permission.signing_secret_encrypted);
      } catch {
        throw new Error("Could not read the factory event signer.");
      }
      return signedMessage({ secret, event: event.data });
    },
  });
  if (result.kind === "skipped") return true;

  const { outcome, httpStatus, retryAfter } = deliverySettlement(result);
  const settlement = await admin
    .rpc("settle_factory_event_delivery", {
      ...identity,
      p_outcome: outcome,
      p_attempt_id: attemptId,
      p_http_status: httpStatus,
      p_retry_after_seconds: retryAfter,
    })
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (settlement.error) throw new Error("Could not settle a factory event delivery.");
  return true;
}

export async function drainFactoryEventDeliveries(admin: AdminClient) {
  const deadline = performance.now() + lastClaimStartMs;
  for (let round = 0; round < batchRounds && performance.now() < deadline; round += 1) {
    const results = await Promise.allSettled(
      Array.from({ length: dispatchConcurrency }, () => dispatchOne(admin)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("A factory event delivery will resume on maintenance.");
    }
    if (results.every((result) => result.status === "fulfilled" && !result.value)) break;
  }
}
