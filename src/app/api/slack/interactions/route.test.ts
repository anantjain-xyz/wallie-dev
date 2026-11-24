import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackClarificationModal,
  slackClarificationAnswerBlockId,
  slackInteractionMaxBytes,
} from "@/lib/connectors/slack/interactions";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { POST } from "./route";

const { adminClient, rpc, readEnv } = vi.hoisted(() => ({
  adminClient: vi.fn(),
  rpc: vi.fn(),
  readEnv: vi.fn(),
}));
vi.mock("@/env/server", () => ({ parseServerEnv: readEnv }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: adminClient }));

const signingSecret = "fixture-signing-secret";
const token = "xoxb-fixture-only";
const appId = "A6780TEST";
const teamId = "T6780TEST";
const userId = "U6780TEST";
const channelId = "C6780TEST";
const viewId = "V6780TEST";
const targetId = "67800000-0000-4000-8000-000000000021";
const modalContextId = "67800000-0000-4000-8000-000000000022";
const messageTs = "1764000001.000053";
const threadTs = "1764000000.000051";
const actionTs = "1764000002.000055";
const triggerId = "12321423423.333649436676.modal-fixture";
const slackIdentity = { api_app_id: appId, team: { id: teamId }, user: { id: userId } };
const scopedRpcArgs = { p_team_id: teamId, p_app_id: appId, p_actor_id: userId };
const signedMessage = { p_channel_id: channelId, p_message_ts: messageTs, p_thread_ts: threadTs };
const fetcher = vi.fn<typeof fetch>();

function button(actionId: string) {
  return {
    ...slackIdentity,
    type: "block_actions",
    container: { type: "message", channel_id: channelId, message_ts: messageTs },
    message: { type: "message", ts: messageTs, thread_ts: threadTs },
    trigger_id: triggerId,
    actions: [{ type: "button", action_id: actionId, value: targetId, action_ts: actionTs }],
    response_url: "https://hooks.slack.com/fixture-only/ignored-secret",
  };
}

function answer(text: string) {
  const modal = buildSlackClarificationModal(modalContextId);
  const [input] = modal.blocks;
  if (!input) throw new Error("Expected a clarification answer input.");
  return {
    ...slackIdentity,
    type: "view_submission",
    view: {
      id: viewId,
      type: modal.type,
      callback_id: modal.callback_id,
      private_metadata: modal.private_metadata,
      state: {
        values: {
          [input.block_id]: {
            [input.element.action_id]: { type: input.element.type, value: text },
          },
        },
      },
    },
  };
}

function form(payload: unknown) {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function request(
  body: string,
  signedBody = body,
  mediaType = "application/x-www-form-urlencoded; charset=UTF-8",
) {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${signedBody}`)
    .digest("hex");
  return new Request("https://wallie.dev/api/slack/interactions", {
    method: "POST",
    headers: {
      "Content-Type": mediaType,
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${signature}`,
    },
    body,
  });
}

function nextRpc(data: unknown, error: { message: string } | null = null) {
  rpc.mockReturnValueOnce({ abortSignal: vi.fn().mockResolvedValue({ data, error }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  adminClient.mockReturnValue({ rpc });
  readEnv.mockReturnValue({ SLACK_APP_ID: appId, SLACK_SIGNING_SECRET: signingSecret });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "fixture-token-encryption-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Slack interactions POST", () => {
  it("verifies the raw form before using its payload and requires the configured Slack app", async () => {
    const raw = form(button("wallie_approve"));
    expect((await POST(request(raw.replace("%3A", "%3a"), raw))).status).toBe(401);
    expect(
      (await POST(request(form({ ...button("wallie_approve"), api_app_id: "A9999999" })))).status,
    ).toBe(400);
    expect(adminClient).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported media, unconfigured verification and oversized bodies before dispatch", async () => {
    const raw = form(button("wallie_approve"));
    expect((await POST(request(raw, raw, "application/json"))).status).toBe(415);
    expect((await POST(request(raw.padEnd(slackInteractionMaxBytes + 1)))).status).toBe(413);
    readEnv.mockReturnValue({});
    expect((await POST(request(raw))).status).toBe(503);
    expect(adminClient).not.toHaveBeenCalled();
  });

  it("acknowledges unrelated and URL-only signed interactions without dispatch", async () => {
    for (const payload of [button("wallie_open"), { type: "shortcut" }]) {
      const response = await POST(request(form(payload)));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(adminClient).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queues approval exactly once per callback using only the signed actor, source and target", async () => {
    nextRpc("queued");
    const response = await POST(request(form(button("wallie_approve"))));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("queue_slack_review_action", {
      ...scopedRpcArgs,
      ...signedMessage,
      p_action: "approve",
      p_context_id: targetId,
      p_delivery_key: `approve:${actionTs}`,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens and registers the modal with a separately issued context and temporary trigger", async () => {
    nextRpc([{ modal_context_id: modalContextId, encrypted_token: encryptSecretValue(token) }]);
    nextRpc(true);
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, view: { id: viewId } }));

    const response = await POST(request(form(button("wallie_answer"))));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(rpc).toHaveBeenNthCalledWith(1, "prepare_slack_clarification_modal", {
      ...scopedRpcArgs,
      ...signedMessage,
      p_target_id: targetId,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://slack.com/api/views.open", {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: buildSlackClarificationModal(modalContextId),
      }),
      signal: expect.any(AbortSignal),
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "register_slack_clarification_view", {
      p_modal_context_id: modalContextId,
      p_view_id: viewId,
    });
  });

  it("acknowledges a denied modal request without obtaining a token or calling Slack", async () => {
    nextRpc([]);
    const response = await POST(request(form(button("wallie_answer"))));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a generic failure when the opened view could not be registered", async () => {
    nextRpc([{ modal_context_id: modalContextId, encrypted_token: encryptSecretValue(token) }]);
    nextRpc(false);
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, view: { id: viewId } }));
    const response = await POST(request(form(button("wallie_answer"))));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Slack interactions are unavailable." });
  });

  it("does not bind a view when Slack fails and keeps provider response details private", async () => {
    nextRpc([{ modal_context_id: modalContextId, encrypted_token: encryptSecretValue(token) }]);
    fetcher.mockResolvedValueOnce(
      Response.json({ ok: false, error: "fixture_private_provider_detail" }),
    );
    const response = await POST(request(form(button("wallie_answer"))));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Slack interactions are unavailable." });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("uses the submitted modal identity and UUID for the authoritative queued answer", async () => {
    nextRpc("replayed");
    const text = "Line one: +7\nLine two: 100%";
    expect((await POST(request(form(answer(text))))).status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("queue_slack_review_action", {
      ...scopedRpcArgs,
      p_action: "answer",
      p_context_id: modalContextId,
      p_delivery_key: `answer:${viewId}`,
      p_view_id: viewId,
      p_answer: text,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a field error for an invalid answer before handling a session command", async () => {
    const response = await POST(request(form(answer(" \n "))));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_action: "errors",
      errors: {
        [slackClarificationAnswerBlockId]: "Enter an answer between 1 and 2,000 characters.",
      },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["denied", "stale"])(
    "keeps modal answers intact after a %s decision without disclosing a reason",
    async (decision) => {
      nextRpc(decision);
      const response = await POST(request(form(answer("A valid answer"))));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        response_action: "errors",
        errors: {
          [slackClarificationAnswerBlockId]:
            "This clarification is unavailable. Open Wallie to see its current state.",
        },
      });
    },
  );

  it("uses a generic retryable response for persistence errors", async () => {
    nextRpc(null, { message: "fixture_private_database_detail" });
    const response = await POST(request(form(button("wallie_approve"))));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Slack interactions are unavailable." });
  });
});
