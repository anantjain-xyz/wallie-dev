import { z } from "zod/v4";

const slackOrigin = "https://slack.com";
const requestTimeoutMs = 5_000;
const clockSkewMs = 60_000;
const editSettlingMs = 30_000;
const pageLimit = 15;
const pageBudget = 4;
const bodyLimit = 512 * 1024;

const nonce = z.uuid().toLowerCase();
const timestamp = z.string().regex(/^(?:0|[1-9][0-9]{0,12})\.[0-9]{6}$/u);
const instant = z.iso.datetime({ offset: true });
const teamId = z.string().regex(/^T[A-Z0-9]{2,31}$/u);
const channelId = z.string().regex(/^[CG][A-Z0-9]{2,31}$/u);
const userId = z.string().regex(/^[UW][A-Z0-9]{2,31}$/u);
const botId = z.string().regex(/^B[A-Z0-9]{2,31}$/u);
const blockId = z.string().min(1).max(255);
const outboundBlock = z
  .looseObject({
    type: z.string().min(1).max(64),
    block_id: blockId.optional(),
  })
  .refine((value) => z.json().safeParse(value).success);
const scopeSchema = z.object({
  botToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\s\p{Cc}]+$/u),
  botUserId: userId,
  teamId,
  channelId,
  threadTs: timestamp,
  correlationId: nonce,
  message: z.object({
    text: z
      .string()
      .min(1)
      .max(4_000)
      .refine((value) => value.trim().length > 0),
    blocks: z.array(outboundBlock).max(50).optional(),
  }),
  replyTs: timestamp.optional(),
  previousCorrelationId: nonce.optional(),
  originalWriteAuthorizedAt: instant,
  deadlineAt: instant,
});
type CheckAuthority = () => Promise<"current" | "unavailable" | "deferred">;
export type SlackOutboundTransportInput = z.input<typeof scopeSchema> & {
  fetcher?: typeof fetch;
  checkAuthority?: CheckAuthority;
};

type Limited =
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "credential_unavailable" };
export type SlackOutboundSendResult =
  | { kind: "sent"; providerReplyId: string }
  | { kind: "not_sent" | "uncertain" | "rejected" }
  | Limited;
export type SlackOutboundObservation =
  | { kind: "found"; providerReplyId: string }
  | { kind: "absent" | "inconclusive" }
  | Limited;

type Scope = z.output<typeof scopeSchema> & {
  deadlineMs: number;
  authorizedMs: number;
  fetcher: typeof fetch;
  checkAuthority?: CheckAuthority;
};
type VerifiedScope = Scope & { botId: string };

const providerMessage = z.object({
  type: z.literal("message").optional(),
  subtype: z.string().max(96).optional(),
  hidden: z.boolean().optional(),
  deleted_ts: timestamp.optional(),
  ts: timestamp.optional(),
  thread_ts: timestamp.optional(),
  user: userId.optional(),
  bot_id: botId.optional(),
  team: teamId.optional(),
  channel: channelId.optional(),
  reply_count: z.number().int().nonnegative().safe().optional(),
  latest_reply: timestamp.optional(),
  edited: z.object({ ts: timestamp }).optional(),
  blocks: z
    .array(z.object({ block_id: blockId.optional() }))
    .max(50)
    .optional(),
});
type ProviderMessage = z.output<typeof providerMessage>;

const replyPage = z.object({
  messages: z.array(providerMessage.extend({ ts: timestamp })).max(pageLimit + 1),
  has_more: z.boolean(),
  is_limited: z.boolean().optional(),
  response_metadata: z
    .object({
      next_cursor: z
        .string()
        .max(1024)
        .regex(/^[^\s\p{Cc}]*$/u)
        .optional(),
    })
    .optional(),
});
const sendResponse = z.object({
  channel: channelId,
  ts: timestamp,
  message: providerMessage,
});
const authResponse = z.object({
  team_id: teamId,
  user_id: userId,
  bot_id: botId,
});
const slackEnvelope = z.discriminatedUnion("ok", [
  z.looseObject({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(96) }),
]);

const credentials = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_expired",
  "token_revoked",
  "team_access_not_granted",
  "app_access_restricted",
]);
const unavailableDestinations = new Set([
  "access_denied",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "no_permission",
  "missing_scope",
  "not_allowed_token_type",
  "thread_not_found",
]);
const rejectedWrites = new Set([
  "block_mismatch",
  "cant_update_message",
  "cannot_reply_to_message",
  "edit_window_closed",
  "invalid_arguments",
  "invalid_blocks",
  "invalid_blocks_format",
  "message_not_found",
  "msg_blocks_too_long",
  "msg_too_long",
  "no_text",
  "too_many_attachments",
]);

type Failure =
  | Limited
  | {
      kind: "ambiguous" | "not_started" | "authority_unavailable";
    }
  | { kind: "refused"; code: string };
type Read<T> = { kind: "read"; value: T } | Failure;

function compareTimestamp(left: string, right: string): number {
  const a = BigInt(left.replace(".", ""));
  const b = BigInt(right.replace(".", ""));
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function slackTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const micros = (milliseconds % 1_000) * 1_000;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

function parseScope(input: SlackOutboundTransportInput): Scope | null {
  const result = scopeSchema.safeParse(input);
  if (!result.success) return null;
  const scope = result.data;
  const authorizedMs = Date.parse(scope.originalWriteAuthorizedAt);
  const deadlineMs = Date.parse(scope.deadlineAt);
  if (
    !Number.isFinite(authorizedMs) ||
    !Number.isFinite(deadlineMs) ||
    authorizedMs < 0 ||
    authorizedMs > Date.now() + clockSkewMs ||
    authorizedMs >= deadlineMs ||
    (scope.replyTs && compareTimestamp(scope.replyTs, scope.threadTs) <= 0) ||
    (scope.previousCorrelationId &&
      (!scope.replyTs || scope.previousCorrelationId === scope.correlationId))
  )
    return null;
  return {
    ...scope,
    authorizedMs,
    deadlineMs,
    fetcher: input.fetcher ?? fetch,
    checkAuthority: input.checkAuthority,
  };
}

function deliveryMarker(correlationId: string): string {
  return `wallie-delivery-${correlationId}`;
}

function outboundBlocks(scope: Scope) {
  const marker = deliveryMarker(scope.correlationId);
  const blocks = scope.message.blocks ?? [];
  if (blocks.some(({ block_id }) => block_id?.startsWith("wallie-delivery-"))) return null;
  const movable = blocks.findIndex((block) => block.type === "section" && !block.accessory);
  if (movable >= 0) {
    return blocks.map((block, index) =>
      index === movable ? { ...block, block_id: marker } : block,
    );
  }

  const characters = Array.from(scope.message.text);
  const messageBlocks = Array.from(
    { length: Math.ceil(characters.length / 3_000) },
    (_, index) => ({
      type: "section",
      ...(index === 0 ? { block_id: marker } : {}),
      text: {
        type: "mrkdwn",
        text: characters.slice(index * 3_000, (index + 1) * 3_000).join(""),
      },
    }),
  );
  return blocks.length + messageBlocks.length <= 50 ? [...messageBlocks, ...blocks] : null;
}

function limited(response: Response): Limited {
  const retryAfter = response.headers.get("Retry-After");
  const seconds = retryAfter && /^[0-9]+$/u.test(retryAfter) ? Number(retryAfter) : 0;
  return seconds > 0
    ? { kind: "rate_limited", retryAfterSeconds: Math.min(seconds, 3_600) }
    : { kind: "rate_limited" };
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > bodyLimit) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(next.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(body + decoder.decode());
    return parsed;
  } finally {
    reader.releaseLock();
  }
}

type SlackMethod = "auth.test" | "chat.postMessage" | "chat.update" | "conversations.replies";

async function checkAuthority(scope: Scope, signal: AbortSignal) {
  try {
    const authority = await scope.checkAuthority?.();
    if (signal.aborted || Date.now() >= scope.deadlineMs || authority === "deferred") {
      return "not_started";
    }
    return authority === "unavailable" ? "authority_unavailable" : "current";
  } catch {
    return "not_started";
  }
}

async function readSlackResponse(response: Response): Promise<Read<Record<string, unknown>>> {
  if (response.redirected) return { kind: "ambiguous" };
  if (response.status === 429) return limited(response);
  if (response.status === 401 || response.status === 403) return { kind: "credential_unavailable" };
  if (!response.ok) return { kind: "ambiguous" };
  const envelope = slackEnvelope.safeParse(await readJson(response));
  if (!envelope.success) return { kind: "ambiguous" };
  if (envelope.data.ok) return { kind: "read", value: envelope.data };
  if (envelope.data.error === "ratelimited") return limited(response);
  if (credentials.has(envelope.data.error)) return { kind: "credential_unavailable" };
  return { kind: "refused", code: envelope.data.error };
}

async function slackCall(
  scope: Scope,
  signal: AbortSignal,
  method: SlackMethod,
  request: { body: string } | { query: URLSearchParams },
): Promise<Read<Record<string, unknown>>> {
  if (signal.aborted || Date.now() >= scope.deadlineMs) return { kind: "not_started" };
  const before = await checkAuthority(scope, signal);
  if (before !== "current") return { kind: before };
  const timeout = Math.min(requestTimeoutMs, scope.deadlineMs - Date.now());
  if (signal.aborted || timeout <= 0) return { kind: "not_started" };
  const url = new URL(`/api/${method}`, slackOrigin);
  if ("query" in request) url.search = request.query.toString();
  try {
    const response = await scope.fetcher(url, {
      ...("body" in request ? { method: "POST", body: request.body } : { method: "GET" }),
      headers: {
        Authorization: `Bearer ${scope.botToken}`,
        ...("body" in request ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    const result = await readSlackResponse(response);
    const after = await checkAuthority(scope, signal);
    if (after === "current") return result;
    if (method === "chat.postMessage" || method === "chat.update") {
      return result.kind === "rate_limited" ? result : { kind: "ambiguous" };
    }
    return { kind: after };
  } catch {
    return { kind: "ambiguous" };
  }
}

async function verifyBot(scope: Scope, signal: AbortSignal): Promise<Read<VerifiedScope>> {
  const response = await slackCall(scope, signal, "auth.test", { body: "{}" });
  if (response.kind !== "read") return response;
  const identity = authResponse.safeParse(response.value);
  if (
    !identity.success ||
    identity.data.team_id !== scope.teamId ||
    identity.data.user_id !== scope.botUserId
  )
    return { kind: "credential_unavailable" };
  return { kind: "read", value: { ...scope, botId: identity.data.bot_id } };
}

function visibleHere(scope: Scope, message: ProviderMessage): boolean {
  return (
    !message.hidden &&
    !message.deleted_ts &&
    message.subtype !== "message_deleted" &&
    message.subtype !== "tombstone" &&
    (message.team === undefined || message.team === scope.teamId) &&
    (message.channel === undefined || message.channel === scope.channelId)
  );
}

function isVerifiedBot(scope: VerifiedScope, message: ProviderMessage): boolean {
  if (message.user !== undefined && message.user !== scope.botUserId) return false;
  if (message.bot_id !== undefined && message.bot_id !== scope.botId) return false;
  return message.user === scope.botUserId || message.bot_id === scope.botId;
}

function hasMarker(message: ProviderMessage, correlationId: string): boolean {
  const markers = message.blocks?.filter(({ block_id }) =>
    block_id?.startsWith("wallie-delivery-"),
  );
  return markers?.length === 1 && markers[0]?.block_id === deliveryMarker(correlationId);
}

function isCurrentPredecessor(scope: Scope, reply: ProviderMessage): boolean {
  return (
    scope.previousCorrelationId !== undefined &&
    hasMarker(reply, scope.previousCorrelationId) &&
    (reply.edited === undefined ||
      compareTimestamp(reply.edited.ts, slackTimestamp(scope.authorizedMs + clockSkewMs)) <= 0)
  );
}

function inThread(scope: Scope, message: ProviderMessage): boolean {
  return (
    visibleHere(scope, message) &&
    message.ts !== undefined &&
    message.thread_ts === scope.threadTs &&
    compareTimestamp(message.ts, scope.threadTs) > 0
  );
}

type ReplyPage = z.output<typeof replyPage>;

async function readReplies(
  scope: Scope,
  signal: AbortSignal,
  window: { oldest: string; latest: string; limit: number; cursor?: string },
): Promise<Read<ReplyPage>> {
  const { oldest, latest, limit, cursor } = window;
  const query = new URLSearchParams({
    channel: scope.channelId,
    ts: scope.threadTs,
    oldest,
    latest,
    inclusive: "true",
    limit: String(limit),
    ...(cursor ? { cursor } : {}),
  });
  const response = await slackCall(scope, signal, "conversations.replies", {
    query,
  });
  if (response.kind !== "read") return response;
  const page = replyPage.safeParse(response.value);
  if (!page.success || page.data.is_limited) return { kind: "ambiguous" };
  // Slack can prepend the root without counting it toward the reply limit.
  const { messages } = page.data;
  const [first] = messages;
  const hasRootPrefix = first !== undefined && isVisibleRoot(scope, first);
  if (
    messages.length > limit + (hasRootPrefix ? 1 : 0) ||
    (hasRootPrefix && messages.some((message, index) => index > 0 && message.ts === scope.threadTs))
  ) {
    return { kind: "ambiguous" };
  }
  return { kind: "read", value: page.data };
}

function complete(page: ReplyPage): boolean {
  return !page.has_more && !page.response_metadata?.next_cursor;
}

function isVisibleRoot(scope: Scope, message: ProviderMessage): boolean {
  return (
    visibleHere(scope, message) &&
    message.ts === scope.threadTs &&
    (message.thread_ts === undefined || message.thread_ts === scope.threadTs)
  );
}

async function readRoot(scope: Scope, signal: AbortSignal): Promise<Read<ProviderMessage>> {
  const page = await readReplies(scope, signal, {
    oldest: scope.threadTs,
    latest: scope.threadTs,
    limit: 1,
  });
  if (page.kind !== "read") return page;
  const [root] = page.value.messages;
  if (
    root &&
    page.value.messages.length === 1 &&
    complete(page.value) &&
    isVisibleRoot(scope, root)
  ) {
    return { kind: "read", value: root };
  }
  return { kind: "ambiguous" };
}

async function readExactReply(scope: VerifiedScope, signal: AbortSignal, replyTs: string) {
  const page = await readReplies(scope, signal, {
    oldest: replyTs,
    latest: replyTs,
    limit: 1,
  });
  if (page.kind !== "read") return page;
  if (!complete(page.value)) return { kind: "ambiguous" } as const;
  const [first, second] = page.value.messages;
  const reply = first && isVisibleRoot(scope, first) ? second : first;
  if (!reply || reply.ts !== replyTs || !inThread(scope, reply) || !isVerifiedBot(scope, reply))
    return { kind: "refused", code: "message_not_found" } as const;
  return { kind: "read", value: reply } as const;
}

function beforeWrite(failure: Failure): SlackOutboundSendResult {
  if (failure.kind === "rate_limited" || failure.kind === "credential_unavailable") return failure;
  if (failure.kind === "authority_unavailable") return { kind: "credential_unavailable" };
  if (failure.kind === "refused") {
    if (unavailableDestinations.has(failure.code)) return { kind: "credential_unavailable" };
    if (rejectedWrites.has(failure.code)) return { kind: "rejected" };
  }
  return { kind: "not_sent" };
}

function afterWrite(failure: Failure): SlackOutboundSendResult {
  if (failure.kind === "not_started") return { kind: "not_sent" };
  const result = beforeWrite(failure);
  return result.kind === "not_sent" ? { kind: "uncertain" } : result;
}

function missedRead(failure: Failure): SlackOutboundObservation {
  return failure.kind === "rate_limited" || failure.kind === "credential_unavailable"
    ? failure
    : { kind: "inconclusive" };
}

export async function sendSlackOutbound(
  input: SlackOutboundTransportInput,
  signal: AbortSignal,
): Promise<SlackOutboundSendResult> {
  const candidate = parseScope(input);
  if (!candidate) return { kind: "rejected" };
  if (signal.aborted || Date.now() >= candidate.deadlineMs) return { kind: "not_sent" };
  const bot = await verifyBot(candidate, signal);
  if (bot.kind !== "read") return beforeWrite(bot);
  const scope = bot.value;
  const blocks = outboundBlocks(scope);
  if (!blocks) return { kind: "rejected" };

  if (scope.replyTs) {
    if (!scope.previousCorrelationId) return { kind: "rejected" };
    const root = await readRoot(scope, signal);
    if (root.kind !== "read") return beforeWrite(root);
    const reply = await readExactReply(scope, signal, scope.replyTs);
    if (reply.kind !== "read") return beforeWrite(reply);
    if (!isCurrentPredecessor(scope, reply.value)) return { kind: "rejected" };
  }

  if (signal.aborted || Date.now() >= scope.deadlineMs) return { kind: "not_sent" };
  const response = await slackCall(
    scope,
    signal,
    scope.replyTs ? "chat.update" : "chat.postMessage",
    {
      body: JSON.stringify({
        channel: scope.channelId,
        text: scope.message.text,
        blocks,
        ...(scope.replyTs
          ? { ts: scope.replyTs, as_user: true }
          : {
              thread_ts: scope.threadTs,
              unfurl_links: false,
              unfurl_media: false,
            }),
      }),
    },
  );
  if (response.kind !== "read") return afterWrite(response);
  const receipt = sendResponse.safeParse(response.value);
  if (!receipt.success) return { kind: "uncertain" };
  const { channel, ts, message } = receipt.data;
  if (
    channel !== scope.channelId ||
    !visibleHere(scope, message) ||
    !isVerifiedBot(scope, message) ||
    (message.ts !== undefined && message.ts !== ts) ||
    compareTimestamp(ts, scope.threadTs) <= 0 ||
    (message.thread_ts !== undefined && message.thread_ts !== scope.threadTs) ||
    (scope.replyTs ? ts !== scope.replyTs : message.thread_ts !== scope.threadTs) ||
    ((!scope.replyTs || message.blocks !== undefined) && !hasMarker(message, scope.correlationId))
  ) {
    return { kind: "uncertain" };
  }
  return { kind: "sent", providerReplyId: ts };
}

async function observeCreate(
  scope: VerifiedScope,
  signal: AbortSignal,
): Promise<SlackOutboundObservation> {
  const oldest = slackTimestamp(Math.max(0, scope.authorizedMs - clockSkewMs));
  const latest = slackTimestamp(Date.now() + clockSkewMs);
  const visited = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < pageBudget; index++) {
    const page = await readReplies(scope, signal, {
      oldest,
      latest,
      limit: pageLimit,
      cursor,
    });
    if (page.kind !== "read") return missedRead(page);
    const matches = page.value.messages.filter(
      (message) =>
        inThread(scope, message) &&
        compareTimestamp(message.ts, oldest) >= 0 &&
        compareTimestamp(message.ts, latest) <= 0 &&
        isVerifiedBot(scope, message) &&
        hasMarker(message, scope.correlationId),
    );
    if (matches.length === 1 && matches[0])
      return { kind: "found", providerReplyId: matches[0].ts };
    if (matches.length > 1) return { kind: "inconclusive" };
    const next = page.value.response_metadata?.next_cursor;
    if (!next || visited.has(next)) break;
    visited.add(next);
    cursor = next;
  }
  // A current miss cannot distinguish a failed write from a reply someone deleted.
  return { kind: "inconclusive" };
}

export async function observeSlackOutbound(
  input: SlackOutboundTransportInput,
  signal: AbortSignal,
): Promise<SlackOutboundObservation> {
  const candidate = parseScope(input);
  if (!candidate || signal.aborted || Date.now() >= candidate.deadlineMs)
    return { kind: "inconclusive" };
  const bot = await verifyBot(candidate, signal);
  if (bot.kind !== "read") return missedRead(bot);
  const scope = bot.value;
  const root = await readRoot(scope, signal);
  if (root.kind !== "read") return missedRead(root);
  if (!scope.replyTs) return observeCreate(scope, signal);

  const reply = await readExactReply(scope, signal, scope.replyTs);
  if (reply.kind !== "read") return missedRead(reply);
  if (hasMarker(reply.value, scope.correlationId))
    return { kind: "found", providerReplyId: scope.replyTs };
  if (!isCurrentPredecessor(scope, reply.value) || Date.now() - scope.authorizedMs < editSettlingMs)
    return { kind: "inconclusive" };

  const currentRoot = await readRoot(scope, signal);
  if (currentRoot.kind !== "read") return missedRead(currentRoot);
  if (
    currentRoot.value.reply_count !== root.value.reply_count ||
    currentRoot.value.latest_reply !== root.value.latest_reply
  )
    return { kind: "inconclusive" };
  const again = await readExactReply(scope, signal, scope.replyTs);
  if (again.kind !== "read") return missedRead(again);
  if (hasMarker(again.value, scope.correlationId))
    return { kind: "found", providerReplyId: scope.replyTs };
  return isCurrentPredecessor(scope, again.value) &&
    again.value.edited?.ts === reply.value.edited?.ts
    ? { kind: "absent" }
    : { kind: "inconclusive" };
}
