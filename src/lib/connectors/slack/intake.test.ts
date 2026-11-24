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

function setup(responses: Response[]) {
  const database = vi.fn<typeof fetch>();
  database
    .mockResolvedValueOnce(
      Response.json([
        {
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

async function expectRetry(responses: Response[], delay: number) {
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
    p_result: "retry",
    p_retry_after_seconds: delay,
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
        Response.json(
          { ok: false, error: "ratelimited" },
          { status, headers: { "Retry-After": header } },
        ),
      ],
      delay,
    );
  });

  it("preserves the default retry when the bot's channel inventory is incomplete", async () => {
    await expectRetry(
      [
        Response.json({ ok: true, team_id: teamId, user_id: botUserId, bot_id: "BTEST01" }),
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
});
