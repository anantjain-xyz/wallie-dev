import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorOutboundTarget } from "@/lib/connectors/outbound";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { createSlackConnectorOutboundAdapter } from "./outbound";

const uuid = (suffix: string) => `67900000-0000-4000-8000-0000000000${suffix}`;
const replyTs = "1732400000.000052";
const target: ConnectorOutboundTarget = {
  correlationId: uuid("01"),
  leaseId: uuid("02"),
  externalResourceId: "C6790TEST",
  externalThreadId: "1732400000.000050",
  installationId: uuid("03"),
  installationGeneration: 1,
  mappingRevision: 1,
  credentialRef: uuid("04"),
  credentialMaterialRevision: null,
  message: {
    operation: "reply",
    content: {
      kind: "review_ready",
      body: "Wallie published an artifact for review.",
      sessionId: uuid("05"),
      reviewTarget: {
        stageId: uuid("06"),
        stageSlug: "specification",
        artifactId: uuid("07"),
        artifactVersion: 1,
        reviewRevision: 1,
        clarificationId: null,
      },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function adapterFixture(
  onRead: (read: number) => "superseded" | "lost" | "busy" | "paused" | undefined,
) {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://wallie.example");
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "slack-outbound-local-test-key");
  let reads = 0;
  const context = {
    session_id: uuid("05"),
    session_number: 17,
    workspace_slug: "fixture",
    team_id: "T6790TEST",
    app_id: "A6790TEST",
    bot_user_id: "U6790TEST",
    channel_id: target.externalResourceId,
    thread_ts: target.externalThreadId,
    encrypted_token: encryptSecretValue("xoxb-fixture"),
    original_write_authorized_at: new Date(Date.now() - 1_000).toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    action_target_id: uuid("08"),
    review_revision: 1,
    previous_correlation_id: null,
  };
  const registerCard = vi.fn<(params: unknown) => Response>(() => Response.json(true));
  const databaseFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("/rpc/register_slack_review_card")) {
      return registerCard(await new Request(input, init).json());
    }
    expect(endpoint).toMatch(/\/rpc\/resolve_slack_connector_delivery$/);
    const status = onRead(++reads);
    if (status === "busy") {
      return Response.json({ code: "55P03", message: "Lock unavailable." }, { status: 409 });
    }
    if (status === "lost") return Response.json([]);
    return Response.json([
      { ...context, superseded: status === "superseded", review_paused: status === "paused" },
    ]);
  });
  const slackFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ ok: true, team_id: "T6790TEST", user_id: "U6790TEST", bot_id: "B6790TEST" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        channel: context.channel_id,
        ts: replyTs,
        message: {
          type: "message",
          ts: replyTs,
          thread_ts: context.thread_ts,
          user: context.bot_user_id,
          bot_id: "B6790TEST",
          blocks: [{ block_id: `wallie-delivery-${target.correlationId}` }],
        },
      }),
    );
  vi.stubGlobal("fetch", slackFetch);
  const admin = createClient<Database>("https://database.example", "local-fixture-key", {
    global: { fetch: databaseFetch },
  });
  return { adapter: createSlackConnectorOutboundAdapter(admin), slackFetch, registerCard };
}

describe("Slack review card revision fence", () => {
  it.each([
    [1, 0, "not_sent"],
    [4, 1, "not_sent"],
    [5, 2, "uncertain"],
  ])(
    "defers an archived review first seen on authority check %i",
    async (readAt, slackCalls, kind) => {
      const { adapter, slackFetch, registerCard } = adapterFixture((read) =>
        read >= readAt ? "paused" : undefined,
      );
      await expect(adapter.send(target, new AbortController().signal)).resolves.toEqual({ kind });
      expect(slackFetch).toHaveBeenCalledTimes(slackCalls);
      expect(registerCard).not.toHaveBeenCalled();
    },
  );

  it("releases a definite no-write when the exact review changes during preflight", async () => {
    const { adapter, slackFetch } = adapterFixture((read) =>
      read >= 3 ? "superseded" : undefined,
    );
    expect(await adapter.send(target, new AbortController().signal)).toEqual({ kind: "not_sent" });
    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(String(slackFetch.mock.calls[0]?.[0])).toContain("/api/auth.test");
  });

  it("preserves uncertainty when the exact review changes after the provider request", async () => {
    const { adapter, slackFetch, registerCard } = adapterFixture((read) =>
      read >= 5 ? "superseded" : undefined,
    );
    expect(await adapter.send(target, new AbortController().signal)).toEqual({ kind: "uncertain" });
    expect(slackFetch).toHaveBeenCalledTimes(2);
    expect(String(slackFetch.mock.calls[1]?.[0])).toContain("/api/chat.postMessage");
    expect(registerCard).not.toHaveBeenCalled();
  });
});

describe("Slack delivery authority lookup", () => {
  it.each([
    [1, 0],
    [3, 1],
    [4, 1],
  ])(
    "can retry a write when preflight lookup %i encounters a busy database",
    async (readAt, reads) => {
      const { adapter, slackFetch } = adapterFixture((read) =>
        read === readAt ? "busy" : undefined,
      );
      await expect(adapter.send(target, new AbortController().signal)).resolves.toEqual({
        kind: "not_sent",
      });
      expect(slackFetch).toHaveBeenCalledTimes(reads);
      expect(
        slackFetch.mock.calls.every(([input]) => String(input).endsWith("/api/auth.test")),
      ).toBe(true);
    },
  );

  it.each(["lost", "busy"] as const)(
    "preserves uncertainty without registering a valid receipt when authority is %s after the write",
    async (status) => {
      const { adapter, slackFetch, registerCard } = adapterFixture((read) =>
        read === 5 ? status : undefined,
      );
      await expect(adapter.send(target, new AbortController().signal)).resolves.toEqual({
        kind: "uncertain",
      });
      expect(slackFetch).toHaveBeenCalledTimes(2);
      expect(String(slackFetch.mock.calls[1]?.[0])).toContain("/api/chat.postMessage");
      expect(registerCard).not.toHaveBeenCalled();
    },
  );

  it("registers the exact valid receipt when authority stays current", async () => {
    const { adapter, registerCard } = adapterFixture(() => undefined);
    await expect(adapter.send(target, new AbortController().signal)).resolves.toEqual({
      kind: "sent",
      providerReplyId: replyTs,
    });
    expect(registerCard).toHaveBeenCalledExactlyOnceWith({
      p_target_id: uuid("08"),
      p_team_id: "T6790TEST",
      p_app_id: "A6790TEST",
      p_channel_id: target.externalResourceId,
      p_thread_ts: target.externalThreadId,
      p_message_ts: replyTs,
    });
  });
});
