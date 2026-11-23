import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";

import { handleSentryAlert } from "./sentry";

const bindingId = "66710000-0000-4000-8000-000000000270";
const installationId = "66710000-0000-4000-8000-000000000271";
const commandId = "66710000-0000-4000-8000-000000000250";
const incidentId = "66710000-0000-4000-8000-000000000272";
const fullRevision = "c".repeat(40);
const signingSecret = "sentry-synthetic-signing-secret";
const eventAt = "2026-11-23T20:30:01.670000Z";

const event = {
  event_id: "a".repeat(32),
  issue_id: "751",
  project: 98765,
  datetime: eventAt,
  release: fullRevision,
  tags: [
    ["wallie_delivery_command", commandId],
    ["environment", "wallie-m12-fixture"],
  ],
};

function payload(eventPayload = event) {
  return JSON.stringify({
    action: "triggered",
    installation: { uuid: installationId },
    data: { event: eventPayload },
  });
}

function signedRequest(body: string, signBody = body) {
  return new Request("http://127.0.0.1/api/monitoring/sentry/" + bindingId, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Sentry-Hook-Resource": "event_alert",
      "Sentry-Hook-Signature": createHmac("sha256", signingSecret).update(signBody).digest("hex"),
      "Sentry-Hook-Timestamp": "ignored unsigned header",
    },
    body,
  });
}

function makeAdmin({
  configured = true,
  result = { status: "queued", incidentId } as { status: string; incidentId?: string },
} = {}) {
  const rpc = vi.fn((name: string) => ({
    abortSignal: async () => ({
      error: null,
      data:
        name === "read_factory_monitoring_secret"
          ? configured
            ? { encryptedSecret: encryptSecretValue(signingSecret) }
            : null
          : result,
    }),
  }));
  return { rpc, admin: { rpc } as never };
}

beforeEach(() => vi.stubEnv("WALLIE_ENCRYPTION_KEY", "fixture-only encryption key"));
afterEach(() => vi.unstubAllEnvs());

describe("Sentry monitoring intake", () => {
  it("authenticates exact bytes and passes only scoped typed evidence into durable admission", async () => {
    const { rpc, admin } = makeAdmin();
    const response = await handleSentryAlert(signedRequest(payload()), bindingId, admin);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued", incidentId });
    expect(rpc).toHaveBeenNthCalledWith(1, "read_factory_monitoring_secret", {
      p_binding_id: bindingId,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "record_factory_monitoring_signal", {
      p_binding_id: bindingId,
      p_installation_id: installationId,
      p_project_id: "98765",
      p_issue_id: "751",
      p_event_id: "a".repeat(32),
      p_command_id: commandId,
      p_source_sha: fullRevision,
      p_environment: "wallie-m12-fixture",
      p_event_at: eventAt,
      p_body_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each(["{", payload() + " "])(
    "rejects a modified body before parsing or writing",
    async (body) => {
      const { rpc, admin } = makeAdmin();
      const response = await handleSentryAlert(signedRequest(body, payload()), bindingId, admin);
      expect(response.status).toBe(401);
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an authentic payload with duplicate deployment tags", async () => {
    const { rpc, admin } = makeAdmin();
    const body = payload({
      ...event,
      tags: [...event.tags, ["wallie_delivery_command", commandId]],
    });
    expect((await handleSentryAlert(signedRequest(body), bindingId, admin)).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed event whose two release values disagree", async () => {
    const { rpc, admin } = makeAdmin();
    const body = payload({ ...event, tags: [...event.tags, ["release", "b".repeat(40)]] });
    expect((await handleSentryAlert(signedRequest(body), bindingId, admin)).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not read configuration for an oversized signed body", async () => {
    const { rpc, admin } = makeAdmin();
    expect(
      (await handleSentryAlert(signedRequest("x".repeat(256 * 1024 + 1)), bindingId, admin)).status,
    ).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a disabled or unknown binding with the authentication response", async () => {
    const { rpc, admin } = makeAdmin({ configured: false });
    expect((await handleSentryAlert(signedRequest(payload()), bindingId, admin)).status).toBe(401);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "ignored", responseStatus: 202 },
    { status: "rate_limited", responseStatus: 429 },
  ])("preserves database outcome $status", async ({ status, responseStatus }) => {
    const { admin } = makeAdmin({ result: { status } });
    const response = await handleSentryAlert(signedRequest(payload()), bindingId, admin);
    expect(response.status).toBe(responseStatus);
    expect(await response.json()).toEqual({ status });
  });
});
