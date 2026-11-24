import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { drainSlackConnectorEvents } from "./intake";

const queueId = "67700000-0000-4000-8000-000000000001";
const leaseId = "67700000-0000-4000-8000-000000000002";
const token = "xoxb-fixture-token";
const teamId = "TTEST01";
const channelId = "CTEST01";
const botUserId = "UTEST01";

const verifiedBot = () =>
  Response.json({ ok: true, team_id: teamId, user_id: botUserId, bot_id: "BTEST01" });

function setup(responses: Response[]) {
  const database = vi.fn<typeof fetch>();
  database
    .mockResolvedValueOnce(
      Response.json([
        {
          kind: "event",
          queue_id: queueId,
          lease_id: leaseId,
          team_id: teamId,
          app_id: "ATEST01",
          channel_id: channelId,
          bot_user_id: botUserId,
          encrypted_token: encryptSecretValue(token),
          deadline_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ]),
    )
    .mockResolvedValueOnce(Response.json("retry"))
    .mockResolvedValueOnce(Response.json([]));
  const admin = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: database },
  });
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return { admin, database, fetcher };
}

async function expectRetry(responses: Response[], delay: number, rateLimitedMethod?: string) {
  const { admin, database, fetcher } = setup(responses);
  await drainSlackConnectorEvents(admin, { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(responses.length);
  const settlement = database.mock.calls[1];
  if (!settlement) throw new Error("Expected a Slack event settlement.");
  const request = new Request(...settlement);
  expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/settle_slack_connector_event");
  expect(await request.json()).toEqual({
    p_queue_id: queueId,
    p_lease_id: leaseId,
    p_result: rateLimitedMethod ? "rate_limited" : "retry",
    p_retry_after_seconds: delay,
    ...(rateLimitedMethod ? { p_rate_limited_method: rateLimitedMethod } : {}),
  });
}

describe("Slack intake membership retry", () => {
  beforeEach(() => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "fixture-slack-intake-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "HTTP 429", status: 429, header: "120", delay: 120 },
    { name: "Slack ratelimited envelope", status: 200, header: "45", delay: 45 },
    { name: "overlong delay", status: 429, header: "3600", delay: 900 },
    { name: "malformed delay", status: 429, header: "not-a-delay", delay: 15 },
  ])("settles the bounded Retry-After delay from $name", async ({ status, header, delay }) => {
    await expectRetry(
      [
        verifiedBot(),
        Response.json(
          { ok: false, error: "ratelimited" },
          { status, headers: { "Retry-After": header } },
        ),
      ],
      delay,
      "conversations.info",
    );
  });

  it("uses the actual Slack method when authentication is throttled first", async () => {
    await expectRetry([Response.json({}, { status: 429 })], 15, "auth.test");
  });

  it("preserves the default retry when the bot's channel inventory is incomplete", async () => {
    await expectRetry(
      [
        verifiedBot(),
        Response.json({
          ok: true,
          channel: {
            id: channelId,
            name: "wallie",
            is_private: false,
            is_channel: true,
            is_im: false,
            is_mpim: false,
            is_archived: false,
            is_shared: false,
          },
        }),
        ...[1, 2, 3, 4].map((page) =>
          Response.json({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: `cursor-${page}` },
          }),
        ),
      ],
      15,
    );
  });

  it("continues past bounded cleanup without provider access and stops on a truly empty queue", async () => {
    const { admin, database, fetcher } = setup([]);
    database
      .mockReset()
      .mockResolvedValueOnce(Response.json([{ kind: "cleanup" }]))
      .mockResolvedValueOnce(Response.json([]));

    await drainSlackConnectorEvents(admin, { fetcher });

    expect(database).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("settles an owned receipt while draining and stops before the next claim", async () => {
    const { admin, database, fetcher } = setup([]);
    let draining = false;
    fetcher.mockImplementationOnce(async () => {
      draining = true;
      return Response.json({}, { status: 429 });
    });

    await drainSlackConnectorEvents(admin, { fetcher, isShuttingDown: () => draining });

    expect(database).toHaveBeenCalledTimes(2);
    expect(database.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(database.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const settlement = database.mock.calls[1];
    if (!settlement) throw new Error("Expected a Slack event settlement.");
    expect(new URL(new Request(...settlement).url).pathname).toBe(
      "/rest/v1/rpc/settle_slack_connector_event",
    );
  });

  it("leaves recovery to the exact lease after an ambiguous settlement error", async () => {
    const { admin, database, fetcher } = setup([Response.json({}, { status: 429 })]);
    const claim = await database("https://database.example.test/fixture-claim");
    database
      .mockReset()
      .mockResolvedValueOnce(claim)
      .mockRejectedValueOnce(new Error("fetch aborted"));

    await expect(drainSlackConnectorEvents(admin, { fetcher })).rejects.toThrow(
      "Could not settle a Slack connector event.",
    );
    expect(database).toHaveBeenCalledTimes(2);
  });
});
