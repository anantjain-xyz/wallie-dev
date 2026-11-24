import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  observeSlackOutbound,
  sendSlackOutbound,
  type SlackOutboundTransportInput,
} from "./outbound-transport";

const now = Date.parse("2026-11-24T16:00:00Z");
const seconds = now / 1_000;
const slackTs = (offset: number, fraction = "000001") => `${seconds + offset}.${fraction}`;
const teamId = "T676700001";
const channelId = "C676700001";
const botUserId = "U676700001";
const botId = "B676700001";
const threadTs = slackTs(-86_400);
const correlationId = "67900000-0000-4000-8000-000000000001";
const previousCorrelationId = "67900000-0000-4000-8000-000000000002";
const anotherCorrelationId = "67900000-0000-4000-8000-000000000003";
const marker = (id: string) => `wallie-delivery-${id}`;
const replyTs = slackTs(-1_000);
const currentReplyTs = slackTs(-55, "000103");
const authorization = () => new AbortController().signal;
const root = {
  type: "message",
  user: "U676700002",
  ts: threadTs,
  thread_ts: threadTs,
  reply_count: 2,
  latest_reply: currentReplyTs,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(() => vi.useRealTimers());

function input(fetcher: typeof fetch, extra: Partial<SlackOutboundTransportInput> = {}) {
  return {
    botToken: "xoxb-synthetic-credential",
    botUserId,
    teamId,
    channelId,
    threadTs,
    correlationId,
    message: { text: "Status from the test fixture" },
    originalWriteAuthorizedAt: new Date(now - 60_000).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
    fetcher,
    ...extra,
  } satisfies SlackOutboundTransportInput;
}

function reply(ts: string, id = correlationId, overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    ts,
    thread_ts: threadTs,
    user: botUserId,
    bot_id: botId,
    team: teamId,
    blocks: [{ type: "section", block_id: marker(id) }],
    ...overrides,
  };
}

function authorizationRead(overrides: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    user_id: botUserId,
    bot_id: botId,
    team_id: teamId,
    ...overrides,
  });
}

function page(messages: unknown[], extra: Record<string, unknown> = {}) {
  return Response.json({ ok: true, has_more: false, messages, ...extra });
}

function senderResponse(ts: string, message: unknown) {
  return Response.json({ ok: true, channel: channelId, ts, message });
}

function request(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetcher.mock.calls[index];
  if (!call) throw new Error("Missing expected Slack request.");
  return new Request(...call);
}

it("posts a tagged reply under the exact fixed HTTPS endpoint and verified bot", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(
      senderResponse(currentReplyTs, reply(currentReplyTs, correlationId, { user: undefined })),
    );
  await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "sent",
    providerReplyId: currentReplyTs,
  });
  expect(request(fetcher, 0).url).toBe("https://slack.com/api/auth.test");
  expect(request(fetcher, 0).method).toBe("POST");
  const send = request(fetcher, 1);
  expect(send.url).toBe("https://slack.com/api/chat.postMessage");
  expect(send.redirect).toBe("error");
  expect(send.headers.get("authorization")).toBe("Bearer xoxb-synthetic-credential");
  expect(await send.json()).toEqual({
    channel: channelId,
    thread_ts: threadTs,
    text: "Status from the test fixture",
    blocks: [
      {
        type: "section",
        block_id: marker(correlationId),
        text: { type: "mrkdwn", text: "Status from the test fixture" },
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps existing interactive Block Kit IDs while tagging a passive block", async () => {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "Review draft" } },
    {
      type: "actions",
      block_id: "existing-action-block",
      elements: [{ type: "button", action_id: "approve" }],
    },
  ];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(senderResponse(currentReplyTs, reply(currentReplyTs)));
  await expect(
    sendSlackOutbound(
      input(fetcher, { message: { text: "Review draft", blocks } }),
      authorization(),
    ),
  ).resolves.toMatchObject({ kind: "sent" });
  expect((await request(fetcher, 1).json()).blocks).toEqual([
    { ...blocks[0], block_id: marker(correlationId) },
    blocks[1],
  ]);
  expect(blocks[0]).not.toHaveProperty("block_id");
});

it.each([{ team_id: "T676700099" }, { user_id: "U676700099" }, { bot_id: undefined }])(
  "does not write through an unauthorized auth.test identity %o",
  async (identity) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(authorizationRead(identity));
    await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
      kind: "credential_unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { user: "U676700099" },
  { bot_id: "B676700099" },
  { thread_ts: slackTs(-100) },
  { ts: slackTs(-54) },
  { blocks: [] },
])("keeps a write uncertain when the response loses exact evidence %o", async (overrides) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(
      senderResponse(currentReplyTs, reply(currentReplyTs, correlationId, overrides)),
    );
  await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "uncertain",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps the reply uncertain after a lost POST response and sends it only once", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockRejectedValueOnce(new TypeError("lost"));
  await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "uncertain",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  ["channel_not_found", "credential_unavailable"],
  ["not_in_channel", "credential_unavailable"],
  ["message_not_found", "rejected"],
  ["invalid_blocks", "rejected"],
  ["internal_error", "uncertain"],
] as const)("classifies definitive versus ambiguous Slack write error %s", async (error, kind) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(Response.json({ ok: false, error }));
  await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({ kind });
});

it("uses Slack Retry-After without retrying the request inline", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "27" } }));
  await expect(sendSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "rate_limited",
    retryAfterSeconds: 27,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("settles the exact correlation on a later bounded thread page and never posts during observation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(
      page(
        [
          reply(slackTs(-85), correlationId, {
            user: "U676700099",
            bot_id: undefined,
          }),
        ],
        {
          has_more: true,
          response_metadata: { next_cursor: "page-two" },
        },
      ),
    )
    .mockResolvedValueOnce(
      page([
        reply(slackTs(-75), correlationId, { team: "T676700097" }),
        reply(slackTs(-65), correlationId, { subtype: "tombstone" }),
        reply(currentReplyTs),
      ]),
    );
  await expect(observeSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "found",
    providerReplyId: currentReplyTs,
  });
  expect(request(fetcher, 1).url).toContain(`oldest=${threadTs}&latest=${threadTs}`);
  expect(new URL(request(fetcher, 2).url).searchParams.get("oldest")).toBe(slackTs(-120, "000000"));
  expect(new URL(request(fetcher, 3).url).searchParams.get("cursor")).toBe("page-two");
  expect(request(fetcher, 0).method).toBe("POST");
  expect(
    fetcher.mock.calls.slice(1).every((_, index) => {
      const read = request(fetcher, index + 1);
      return read.method === "GET" && new URL(read.url).pathname === "/api/conversations.replies";
    }),
  ).toBe(true);
});

it("keeps an uncertain create open even after a complete valid marker miss", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(currentReplyTs, anotherCorrelationId)]));
  await expect(observeSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
    kind: "inconclusive",
  });
});

it.each([
  () => Response.json({ ok: false, error: "missing_scope" }),
  () => Response.json({ ok: false, error: "not_allowed_token_type" }),
  () => Response.json({ ok: false, error: "thread_not_found" }),
  () => page([{ ...root, subtype: "tombstone" }]),
  () => page([root], { is_limited: true }),
  () => Response.json({ ok: true, messages: [root] }),
])(
  "does not infer absence from an incomplete, deleted, or unavailable root",
  async (rootResponse) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorizationRead())
      .mockResolvedValueOnce(rootResponse());
    await expect(observeSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
      kind: "inconclusive",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("bounds repeated cursors and a continuous stream of incomplete recovery pages", async () => {
  for (const repeated of [true, false]) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorizationRead())
      .mockResolvedValueOnce(page([root]));
    for (let index = 0; index < 6; index++) {
      fetcher.mockResolvedValueOnce(
        page([], {
          has_more: true,
          response_metadata: { next_cursor: `page-${repeated ? 0 : index}` },
        }),
      );
    }
    await expect(observeSlackOutbound(input(fetcher), authorization())).resolves.toEqual({
      kind: "inconclusive",
    });
    expect(fetcher).toHaveBeenCalledTimes(repeated ? 4 : 6);
  }
});

it("edits an exact scoped extant predecessor and accepts Slack's compact edit acknowledgement", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(replyTs, previousCorrelationId)]))
    .mockResolvedValueOnce(senderResponse(replyTs, { user: botUserId }));
  await expect(
    sendSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "sent", providerReplyId: replyTs });
  expect(new URL(request(fetcher, 2).url).searchParams.get("oldest")).toBe(replyTs);
  expect(request(fetcher, 3).url).toBe("https://slack.com/api/chat.update");
  expect(await request(fetcher, 3).json()).toMatchObject({
    channel: channelId,
    ts: replyTs,
    as_user: true,
  });
});

it.each([
  () => page([]),
  () => page([reply(replyTs, anotherCorrelationId)]),
  () => page([reply(replyTs, previousCorrelationId, { thread_ts: slackTs(-500) })]),
  () => page([reply(replyTs, previousCorrelationId, { edited: { ts: slackTs(1) } })]),
])("does not update a deleted or stale edit target", async (oldReply) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(oldReply());
  await expect(
    sendSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "rejected" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("finds an unknown edit on its exact reply ts even when the reply predates its write window", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(replyTs)]));
  await expect(
    observeSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "found", providerReplyId: replyTs });
  const query = new URL(request(fetcher, 2).url).searchParams;
  expect([query.get("oldest"), query.get("latest"), query.get("inclusive")]).toEqual([
    replyTs,
    replyTs,
    "true",
  ]);
});

it("only permits a recovered edit retry after repeated observation of the settled exact predecessor", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(replyTs, previousCorrelationId)]))
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(replyTs, previousCorrelationId)]));
  await expect(
    observeSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "absent" });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("keeps a superseded or deleted reply from turning an unknown edit into another write", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(replyTs, previousCorrelationId)]))
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([]));
  await expect(
    observeSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "inconclusive" });
});

it("keeps an unexpectedly newer exact predecessor inconclusive", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(
      page([reply(replyTs, previousCorrelationId, { edited: { ts: slackTs(1) } })]),
    );
  await expect(
    observeSlackOutbound(input(fetcher, { replyTs, previousCorrelationId }), authorization()),
  ).resolves.toEqual({ kind: "inconclusive" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("reports unavailable authority before dispatch and uncertainty after dispatch", async () => {
  for (const guardAt of [3, 4]) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorizationRead())
      .mockResolvedValueOnce(senderResponse(currentReplyTs, reply(currentReplyTs)));
    let checks = 0;
    const assertCurrent = async () => {
      if (++checks === guardAt) throw new Error("revoked");
    };
    await expect(
      sendSlackOutbound(input(fetcher, { assertCurrent }), authorization()),
    ).resolves.toEqual({
      kind: guardAt === 3 ? "credential_unavailable" : "uncertain",
    });
    expect(fetcher).toHaveBeenCalledTimes(guardAt === 3 ? 1 : 2);
  }
});

it("rejects a read result when exact lease or mapping authority changed during observation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(authorizationRead())
    .mockResolvedValueOnce(page([root]))
    .mockResolvedValueOnce(page([reply(currentReplyTs)]));
  let checks = 0;
  const assertCurrent = async () => {
    if (++checks === 6) throw new Error("mapping changed");
  };
  await expect(
    observeSlackOutbound(input(fetcher, { assertCurrent }), authorization()),
  ).resolves.toEqual({ kind: "inconclusive" });
});

it("makes no provider request after expiry or an already aborted transport", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const expired = input(fetcher, {
    deadlineAt: new Date(now - 1).toISOString(),
  });
  await expect(sendSlackOutbound(expired, authorization())).resolves.toEqual({
    kind: "not_sent",
  });
  await expect(observeSlackOutbound(input(fetcher), AbortSignal.abort())).resolves.toEqual({
    kind: "inconclusive",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
