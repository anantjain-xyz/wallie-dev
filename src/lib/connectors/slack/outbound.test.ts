import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorOutboundTarget } from "@/lib/connectors/outbound";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { createSlackConnectorOutboundAdapter } from "./outbound";

const uuid = (suffix: string) => `67900000-0000-4000-8000-0000000000${suffix}`;
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

function adapterFixture(onRead: (read: number) => "superseded" | "busy" | undefined) {
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
  const databaseFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    expect(String(input)).toContain("/rpc/resolve_slack_connector_delivery");
    const status = onRead(++reads);
    if (status === "busy") {
      return Response.json({ code: "55P03", message: "Lock unavailable." }, { status: 409 });
    }
    return Response.json([{ ...context, superseded: status === "superseded" }]);
  });
  const slackFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ ok: true, team_id: "T6790TEST", user_id: "U6790TEST", bot_id: "B6790TEST" }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", slackFetch);
  const admin = createClient<Database>("https://database.example", "local-fixture-key", {
    global: { fetch: databaseFetch },
  });
  return { adapter: createSlackConnectorOutboundAdapter(admin), slackFetch };
}

describe("Slack review card revision fence", () => {
  it("releases a definite no-write when the exact review changes during preflight", async () => {
    const { adapter, slackFetch } = adapterFixture((read) =>
      read >= 3 ? "superseded" : undefined,
    );
    expect(await adapter.send(target, new AbortController().signal)).toEqual({ kind: "not_sent" });
    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(String(slackFetch.mock.calls[0]?.[0])).toContain("/api/auth.test");
  });

  it("preserves uncertainty when the exact review changes after the provider request", async () => {
    const { adapter, slackFetch } = adapterFixture((read) =>
      read >= 5 ? "superseded" : undefined,
    );
    expect(await adapter.send(target, new AbortController().signal)).toEqual({ kind: "uncertain" });
    expect(slackFetch).toHaveBeenCalledTimes(2);
    expect(String(slackFetch.mock.calls[1]?.[0])).toContain("/api/chat.postMessage");
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

  it("preserves uncertainty if delivery authority cannot be read after the write", async () => {
    const { adapter, slackFetch } = adapterFixture((read) => (read === 5 ? "busy" : undefined));
    await expect(adapter.send(target, new AbortController().signal)).resolves.toEqual({
      kind: "uncertain",
    });
    expect(slackFetch).toHaveBeenCalledTimes(2);
    expect(String(slackFetch.mock.calls[1]?.[0])).toContain("/api/chat.postMessage");
  });
});
