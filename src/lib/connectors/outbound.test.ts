import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  drainConnectorOutboundDeliveries,
  enqueueConnectorOutboundDelivery,
  type ConnectorOutboundAdapter,
} from "./outbound";

const id = (slot: number) => `67100000-0000-4000-8000-${String(slot).padStart(12, "0")}`;

function permit(kind: "sending" | "observing", lease: number) {
  return {
    delivery_id: id(1),
    lease_id: id(lease),
    lease_expires_at: new Date(Date.now() + 45_000).toISOString(),
    kind,
    provider: "linear",
    operation: "reply",
    external_resource_id: "project",
    external_thread_id: "issue",
    content: { purpose: "progress" },
    edit_target: null,
    installation_id: id(2),
    installation_generation: 3,
    mapping_revision: 4,
    credential_ref: id(5),
    credential_material_revision: 6,
  };
}

function fixture(permits: object[], authorized: Array<boolean | (() => boolean)> = []) {
  const rpc = vi.fn().mockImplementation((name: string) => {
    let data: unknown;
    switch (name) {
      case "enqueue_connector_outbound_delivery":
        data = id(1);
        break;
      case "claim_connector_outbound_delivery": {
        const active = permits.shift();
        data = active ? [active] : [];
        break;
      }
      case "confirm_connector_outbound_authority": {
        const permission = authorized.shift() ?? true;
        data = typeof permission === "function" ? permission() : permission;
        break;
      }
      case "settle_connector_outbound_delivery":
        data = true;
        break;
      default:
        throw new Error(`Unexpected RPC ${name}`);
    }
    return { abortSignal: vi.fn().mockResolvedValue({ data, error: null }) };
  });
  const admin = { rpc } as unknown as Pick<SupabaseClient<Database>, "rpc">;
  const calls = (name: string) =>
    rpc.mock.calls.filter(([called]) => called === name).map(([, args]) => args);
  return { admin, calls };
}

function adapter() {
  return {
    provider: "linear",
    send: vi
      .fn<ConnectorOutboundAdapter["send"]>()
      .mockResolvedValue({ kind: "sent", providerReplyId: "reply" }),
    observe: vi
      .fn<ConnectorOutboundAdapter["observe"]>()
      .mockResolvedValue({ kind: "inconclusive" }),
  } satisfies ConnectorOutboundAdapter;
}

it("queues the original source, actor, and edit receipt without a provider call", async () => {
  const { admin, calls } = fixture([]);
  expect(
    await enqueueConnectorOutboundDelivery(admin, {
      workspaceId: id(11),
      factoryId: id(12),
      resourceId: id(13),
      sessionId: id(14),
      sourceId: id(15),
      logicalKey: "progress:edit",
      actorLinkId: id(16),
      editedDeliveryId: id(17),
      operation: "edit",
      content: { purpose: "progress" },
    }),
  ).toBe(id(1));
  expect(calls("enqueue_connector_outbound_delivery")).toEqual([
    {
      p_workspace_id: id(11),
      p_factory_id: id(12),
      p_resource_id: id(13),
      p_session_id: id(14),
      p_source_id: id(15),
      p_logical_key: "progress:edit",
      p_actor_link_id: id(16),
      p_edited_delivery_id: id(17),
      p_operation: "edit",
      p_content: { purpose: "progress" },
    },
  ]);
});

it("retries a proven pre-write failure with the same provider correlation ID", async () => {
  const { admin, calls } = fixture([permit("sending", 10), permit("sending", 11)]);
  const provider = adapter();
  provider.send.mockResolvedValueOnce({ kind: "not_sent" });

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(2);
  expect(provider.send.mock.calls.map(([target]) => target.correlationId)).toEqual([id(1), id(1)]);
  expect(provider.observe).not.toHaveBeenCalled();
  expect(calls("settle_connector_outbound_delivery")).toEqual([
    { p_delivery_id: id(1), p_lease_id: id(10), p_result: "not_sent" },
    { p_delivery_id: id(1), p_lease_id: id(11), p_result: "sent", p_provider_reply_id: "reply" },
  ]);
});

it("settles the Slack delivery already held when shutdown starts without claiming another", async () => {
  let shuttingDown = false;
  const { admin, calls } = fixture(
    [10, 11].map((lease) => ({ ...permit("sending", lease), provider: "slack" })),
    [
      () => {
        shuttingDown = true;
        return true;
      },
    ],
  );
  const provider = { ...adapter(), provider: "slack" } satisfies ConnectorOutboundAdapter;

  await expect(
    drainConnectorOutboundDeliveries(admin, provider, { isShuttingDown: () => shuttingDown }),
  ).resolves.toBe(1);

  expect(provider.send).toHaveBeenCalledOnce();
  expect(calls("claim_connector_outbound_delivery")).toEqual([{ p_provider: "slack" }]);
  expect(calls("settle_connector_outbound_delivery")).toEqual([
    { p_delivery_id: id(1), p_lease_id: id(10), p_result: "sent", p_provider_reply_id: "reply" },
  ]);
});

it("observes the original provider message after a successful write loses its response", async () => {
  const { admin, calls } = fixture([permit("sending", 10), permit("observing", 11)]);
  const provider = adapter();
  const replies = new Map<string, string>();
  provider.send.mockImplementation(async (target) => {
    replies.set(target.correlationId, "provider-reply");
    throw new Error("provider timeout with sensitive response body");
  });
  provider.observe.mockImplementation(async (target) => {
    const replyId = replies.get(target.correlationId);
    return replyId ? { kind: "found", providerReplyId: replyId } : { kind: "inconclusive" };
  });

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(2);
  expect(provider.send).toHaveBeenCalledOnce();
  expect(provider.observe).toHaveBeenCalledOnce();
  expect(replies.size).toBe(1);
  expect(calls("settle_connector_outbound_delivery")).toEqual([
    { p_delivery_id: id(1), p_lease_id: id(10), p_result: "uncertain" },
    {
      p_delivery_id: id(1),
      p_lease_id: id(11),
      p_result: "found",
      p_provider_reply_id: "provider-reply",
    },
  ]);
});

it("settles an observation rate limit without changing its unknown mode", async () => {
  const { admin, calls } = fixture([permit("observing", 10)]);
  const provider = adapter();
  provider.observe.mockResolvedValue({ kind: "rate_limited", retryAfterSeconds: 120 });

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(1);
  expect(provider.send).not.toHaveBeenCalled();
  expect(calls("settle_connector_outbound_delivery")).toEqual([
    {
      p_delivery_id: id(1),
      p_lease_id: id(10),
      p_result: "rate_limited",
      p_retry_after_seconds: 120,
    },
  ]);
});

it("skips provider I/O after the credential changes between claim and confirmation", async () => {
  const { admin, calls } = fixture([permit("sending", 10)], [false]);
  const provider = adapter();

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(0);
  expect(calls("confirm_connector_outbound_authority")).toEqual([
    { p_delivery_id: id(1), p_lease_id: id(10) },
  ]);
  expect(calls("settle_connector_outbound_delivery")).toEqual([]);
  expect(provider.send).not.toHaveBeenCalled();
  expect(provider.observe).not.toHaveBeenCalled();
});

it("passes the confirmed provider reply target to an edit", async () => {
  const { admin } = fixture([
    { ...permit("sending", 10), operation: "edit", edit_target: "reply" },
  ]);
  const provider = adapter();

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(1);
  expect(provider.send).toHaveBeenCalledWith(
    expect.objectContaining({
      correlationId: id(1),
      leaseId: id(10),
      message: { operation: "edit", providerReplyId: "reply", content: { purpose: "progress" } },
    }),
    expect.any(AbortSignal),
  );
});

it("validates and preserves an outbox payload with owned prototype keys", async () => {
  const serialized = '{"__proto__":{"nested":true},"items":[{"__proto__":{"body":"exact"}}]}';
  const content: unknown = JSON.parse(serialized);
  const { admin } = fixture([{ ...permit("sending", 10), content }]);
  const provider = adapter();

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(1);
  expect(JSON.stringify(provider.send.mock.calls[0]?.[0].message.content)).toBe(serialized);
});

it("does not authorize a lease with only the settlement reserve remaining", async () => {
  const { admin, calls } = fixture([
    { ...permit("sending", 10), lease_expires_at: new Date(Date.now() + 4_000).toISOString() },
  ]);
  const provider = adapter();

  await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(0);
  expect(calls("confirm_connector_outbound_authority")).toEqual([]);
  expect(calls("settle_connector_outbound_delivery")).toEqual([]);
  expect(provider.send).not.toHaveBeenCalled();
});

it.each([
  ["sending", "not_sent"],
  ["observing", "inconclusive"],
] as const)(
  "settles the unused %s lease when authorization consumes its remaining transport budget",
  async (kind, result) => {
    const start = Date.now();
    const attempt = {
      ...permit(kind, 10),
      lease_expires_at: new Date(start + 45_000).toISOString(),
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const { admin, calls } = fixture(
      [attempt],
      [
        () => {
          clock.mockReturnValue(start + 42_000);
          return true;
        },
      ],
    );
    const provider = adapter();

    try {
      await expect(drainConnectorOutboundDeliveries(admin, provider)).resolves.toBe(1);
      expect(provider.send).not.toHaveBeenCalled();
      expect(provider.observe).not.toHaveBeenCalled();
      expect(calls("settle_connector_outbound_delivery")).toEqual([
        { p_delivery_id: id(1), p_lease_id: id(10), p_result: result },
      ]);
    } finally {
      clock.mockRestore();
    }
  },
);
