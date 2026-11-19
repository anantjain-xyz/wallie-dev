import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { drainFactoryEventDeliveries } from "./dispatch";
import { postToFactoryEventDestination, type FactoryEventTransportResult } from "./transport";

vi.mock("./transport", () => ({ postToFactoryEventDestination: vi.fn() }));

const claim = {
  delivery_id: "a24490c1-f60d-4d12-88b9-f790ec0b71c9",
  lease_id: "2c883bfd-3fbb-44bc-8315-89eb85442694",
  endpoint_url: "https://receiver.example/hooks",
  subscription_revision: 2,
};
const event = {
  version: 1,
  eventId: "419e0a3c-269e-4a04-b20a-b1236cd74943",
  type: "conversation.message_added",
  occurredAt: "2026-11-19T10:15:00+00:00",
  workspaceId: "1fae1092-a270-467c-bad3-53b3db30b090",
  factoryId: "2e66ce43-a161-4194-b1d4-02dac5330798",
  sessionId: "fddb645a-9714-4139-ba45-11964f6f32ac",
  messageSequence: 2,
};
const attempt = "688ce382-0e41-43f2-9dcc-2850833e043f";
const signingSecret = "synthetic-receiver-signing-secret";

function eventWorker(permission: "authorized" | "revoked" | "unconfirmed" = "authorized") {
  let claimed = false;
  const begin = vi.fn();
  const settle = vi.fn();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : input);
    const args = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    switch (endpoint.pathname.split("/").at(-1)) {
      case "claim_factory_event_delivery": {
        const response = claimed ? [] : [claim];
        claimed = true;
        return Response.json(response);
      }
      case "begin_factory_event_send":
        begin(args);
        if (permission === "unconfirmed") return Response.json({}, { status: 503 });
        return Response.json(
          permission === "revoked"
            ? { outcome: "revoked" }
            : {
                outcome: "authorized",
                attempt_id: attempt,
                event_id: event.eventId,
                event_type: event.type,
                payload: event,
                signing_secret_encrypted: encryptSecretValue(signingSecret),
              },
        );
      case "settle_factory_event_delivery":
        settle(args);
        return Response.json(true);
      default:
        throw new Error("Unexpected event RPC.");
    }
  };
  const admin = createClient<Database>("https://db.example", "local-test-key", {
    global: { fetch },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { admin, begin, settle };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "ab".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  { result: { kind: "response", status: 204 }, outcome: "delivered" },
  {
    result: { kind: "response", status: 429, retryAfter: "86400" },
    outcome: "retryable_failure",
    retryAfter: 3600,
  },
  { result: { kind: "response", status: 503 }, outcome: "retryable_failure" },
  { result: { kind: "response", status: 302 }, outcome: "permanent_failure" },
  { result: { kind: "unknown" }, outcome: "unknown" },
] satisfies { result: FactoryEventTransportResult; outcome: string; retryAfter?: number }[])(
  "settles $result as $outcome using the exact signed event and authorized attempt",
  async ({
    result,
    outcome,
    retryAfter,
  }: {
    result: FactoryEventTransportResult;
    outcome: string;
    retryAfter?: number;
  }) => {
    const { admin, begin, settle } = eventWorker();
    vi.mocked(postToFactoryEventDestination).mockImplementation(async ({ url, prepare }) => {
      expect(url).toBe(claim.endpoint_url);
      const message = await prepare(new AbortController().signal);
      if (!message?.headers) throw new Error("Expected an authorized signed message.");
      expect(JSON.parse(message.body)).toEqual(event);
      expect(message.headers).toMatchObject({
        "Wallie-Event-Id": event.eventId,
        "Wallie-Event-Type": event.type,
      });
      const [, timestamp, signature] =
        /^t=(\d+),v1=([a-f0-9]{64})$/.exec(message.headers["Wallie-Signature"] ?? "") ?? [];
      expect(timestamp).toBeTruthy();
      expect(signature).toBe(
        createHmac("sha256", signingSecret)
          .update(`${timestamp}.${event.eventId}.${message.body}`)
          .digest("hex"),
      );
      return result;
    });
    await drainFactoryEventDeliveries(admin);
    expect(begin).toHaveBeenCalledExactlyOnceWith({
      p_delivery_id: claim.delivery_id,
      p_lease_id: claim.lease_id,
      p_subscription_revision: claim.subscription_revision,
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith({
      p_delivery_id: claim.delivery_id,
      p_lease_id: claim.lease_id,
      p_attempt_id: attempt,
      p_outcome: outcome,
      ...(result.kind === "response" && { p_http_status: result.status }),
      ...(retryAfter === undefined ? {} : { p_retry_after_seconds: retryAfter }),
    });
  },
);

it("does not ask for or expose the private payload when preflight blocks an endpoint", async () => {
  const { admin, begin, settle } = eventWorker();
  vi.mocked(postToFactoryEventDestination).mockResolvedValue({ kind: "rejected" });
  await drainFactoryEventDeliveries(admin);
  expect(begin).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledExactlyOnceWith({
    p_delivery_id: claim.delivery_id,
    p_lease_id: claim.lease_id,
    p_outcome: "permanent_failure",
  });
});

it("does not sign or attempt settlement when the live grant has been revoked", async () => {
  const { admin, begin, settle } = eventWorker("revoked");
  vi.mocked(postToFactoryEventDestination).mockImplementation(async ({ prepare }) => {
    await expect(prepare(new AbortController().signal)).resolves.toBeNull();
    return { kind: "skipped" };
  });
  await drainFactoryEventDeliveries(admin);
  expect(begin).toHaveBeenCalledOnce();
  expect(settle).not.toHaveBeenCalled();
});

it("leaves a lost permit acknowledgement for durable expiry recovery", async () => {
  const { admin, begin, settle } = eventWorker("unconfirmed");
  vi.mocked(postToFactoryEventDestination).mockImplementation(async ({ prepare }) => {
    await prepare(new AbortController().signal);
    throw new Error("An unconfirmed permit must prevent HTTP.");
  });
  await expect(drainFactoryEventDeliveries(admin)).rejects.toThrow(
    "A factory event delivery will resume on maintenance.",
  );
  expect(begin).toHaveBeenCalledOnce();
  expect(settle).not.toHaveBeenCalled();
});
