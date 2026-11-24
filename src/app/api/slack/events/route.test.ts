import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, enqueue } = vi.hoisted(() => ({ rpc: vi.fn(), enqueue: vi.fn() }));
const fixture = vi.hoisted(() => ({ appId: "ATEST01", secret: "local-event-secret" }));
vi.mock("@/env/server", () => ({
  parseServerEnv: () => ({ SLACK_APP_ID: fixture.appId, SLACK_SIGNING_SECRET: fixture.secret }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));

import { POST } from "./route";

function signed(payload: unknown, options: { bodyChanged?: boolean; timestamp?: number } = {}) {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", fixture.secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request("https://wallie.test/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${signature}`,
    },
    body: options.bodyChanged ? `${body} ` : body,
  });
}

function mention() {
  return {
    type: "event_callback",
    team_id: "TTEST01",
    api_app_id: fixture.appId,
    event_id: "EvTEST01",
    event: {
      type: "app_mention",
      user: "UREQUESTER",
      channel: "CTEST01",
      text: "<@UWALLIE> Review the test fixture",
      ts: "1783900010.000001",
      event_ts: "1783900010.000001",
    },
  };
}

describe("Slack Events API", () => {
  beforeEach(() => {
    enqueue.mockReset();
    rpc.mockReset().mockReturnValue({ abortSignal: enqueue });
  });

  it("answers the signed URL challenge before creating an admin client receipt", async () => {
    const response = await POST(
      signed({ type: "url_verification", challenge: "fixture-challenge" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "fixture-challenge" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects altered and expired signatures without queueing work", async () => {
    expect((await POST(signed(mention(), { bodyChanged: true }))).status).toBe(401);
    expect(
      (await POST(signed(mention(), { timestamp: Math.floor(Date.now() / 1_000) - 301 }))).status,
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("acknowledges only after handing the exact message identity to the durable queue", async () => {
    enqueue.mockResolvedValue({ data: "queued", error: null });
    const response = await POST(signed(mention()));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("enqueue_slack_connector_event", {
      p_team_id: "TTEST01",
      p_app_id: "ATEST01",
      p_channel_id: "CTEST01",
      p_event_id: "EvTEST01",
      p_action: "mention",
      p_message_ts: "1783900010.000001",
      p_version_ts: "1783900010.000001",
      p_thread_ts: "1783900010.000001",
      p_actor_id: "UREQUESTER",
      p_body: "<@UWALLIE> Review the test fixture",
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  });

  it("leaves a failed persistence attempt retryable and does not disclose database errors", async () => {
    enqueue.mockResolvedValue({
      data: null,
      error: { code: "55P03", message: "private storage detail" },
    });
    const response = await POST(signed(mention()));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not accept Slack event." });
  });

  it("uses the original request deadline for the durable queue and can return a retry after it ends", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    enqueue.mockImplementationOnce((signal: AbortSignal) => {
      expect(signal).toBe(deadline.signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ error: { code: "57014" } }), {
          once: true,
        });
        queueMicrotask(() => deadline.abort());
      });
    });
    try {
      expect((await POST(signed(mention()))).status).toBe(503);
      expect(timeout).toHaveBeenNthCalledWith(1, 2_600);
    } finally {
      timeout.mockRestore();
    }
  });

  it("acknowledges bot events without entering the queue", async () => {
    const payload = mention();
    const response = await POST(
      signed({ ...payload, event: { ...payload.event, bot_id: "BTEST01" } }),
    );
    expect(response.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });
});
