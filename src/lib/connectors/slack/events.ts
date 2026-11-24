import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  slackAppIdSchema,
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "./contracts";

export const slackEventMaxBytes = 256_000;
const signatureWindowSeconds = 300;
const maxMessageLength = 8_000;
const timestamp = z.string().regex(/^[1-9][0-9]{0,11}\.[0-9]{6}$/);
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const optionalTeam = slackTeamIdSchema.nullish();
const sharedFlags = {
  is_ext_shared_channel: z.boolean().optional(),
  is_ext_shared: z.boolean().optional(),
  is_org_shared: z.boolean().optional(),
  is_pending_ext_shared: z.boolean().optional(),
  is_shared: z.boolean().optional(),
};
const eventCallback = z.object({
  api_app_id: slackAppIdSchema,
  team_id: slackTeamIdSchema.nullable(),
  context_team_id: optionalTeam,
  event_id: eventId,
  event: z.unknown(),
  ...sharedFlags,
});
const messageScope = z.object({
  channel: slackChannelIdSchema.optional(),
  channel_type: z.enum(["channel", "group"]).optional(),
  team: optionalTeam,
  team_id: optionalTeam,
  user_team: optionalTeam,
  source_team: optionalTeam,
  subtype: z.string().nullish(),
  bot_id: z.unknown(),
  bot_profile: z.unknown(),
  app_id: z.unknown(),
  is_bot: z.boolean().optional(),
  ...sharedFlags,
});
const messageSnapshot = messageScope.extend({
  ts: timestamp,
  user: slackUserIdSchema,
  thread_ts: timestamp.optional(),
  text: z.string().optional(),
});
const eventBody = messageScope.extend({
  type: z.enum(["app_mention", "message"]),
  channel: slackChannelIdSchema,
  hidden: z.boolean().optional(),
  ts: timestamp.optional(),
  user: slackUserIdSchema.optional(),
  thread_ts: timestamp.optional(),
  text: z.string().optional(),
  event_ts: timestamp.optional(),
  deleted_ts: timestamp.optional(),
  message: z.unknown(),
  previous_message: z.unknown(),
});
const editedMessage = messageSnapshot.extend({
  edited: z.object({ user: slackUserIdSchema, ts: timestamp }),
});
const bodyKind = z.object({ type: z.string().min(1) });
const challengeBody = z.object({
  challenge: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[!-~]+$/u),
});

type EventScope = {
  kind: "event";
  teamId: string;
  appId: string;
  eventId: string;
  channelId: string;
};

export type SlackEventEnvelope =
  | { kind: "challenge"; challenge: string }
  | { kind: "ignored" }
  | (EventScope & {
      action: "mention" | "created" | "edited";
      messageTs: string;
      threadTs: string;
      versionTs: string;
      actorId: string;
      text: string;
    })
  | (EventScope & {
      action: "deleted";
      messageTs: string;
      threadTs: string | null;
      versionTs: string;
      actorId: string | null;
    });

const ignored = { kind: "ignored" } satisfies SlackEventEnvelope;

export function verifySlackEventSignature({
  body,
  timestamp: signedTimestamp,
  signature,
  signingSecret,
  nowMs = Date.now(),
}: {
  body: Uint8Array;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  signingSecret: string;
  nowMs?: number;
}): boolean {
  if (
    body.byteLength === 0 ||
    body.byteLength > slackEventMaxBytes ||
    !signingSecret ||
    !signedTimestamp ||
    !/^[1-9][0-9]{0,11}$/.test(signedTimestamp) ||
    !signature ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    !Number.isFinite(nowMs) ||
    Math.abs(nowMs / 1_000 - Number(signedTimestamp)) > signatureWindowSeconds
  ) {
    return false;
  }

  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${signedTimestamp}:`)
    .update(body)
    .digest();
  return timingSafeEqual(Buffer.from(signature.slice(3), "hex"), expected);
}

function isShared(scope: z.output<z.ZodObject<typeof sharedFlags>>): boolean {
  return Boolean(
    scope.is_ext_shared_channel ||
    scope.is_ext_shared ||
    scope.is_org_shared ||
    scope.is_pending_ext_shared ||
    scope.is_shared,
  );
}

function inLocalChannel(scope: z.output<typeof messageScope>, { teamId, channelId }: EventScope) {
  return (
    !isShared(scope) &&
    (!scope.channel || scope.channel === channelId) &&
    [scope.team, scope.team_id, scope.user_team, scope.source_team].every(
      (team) => team == null || team === teamId,
    ) &&
    !scope.is_bot &&
    scope.bot_id == null &&
    scope.bot_profile == null &&
    scope.app_id == null
  );
}

function follows(later: string, earlier: string): boolean {
  return later.length === earlier.length ? later > earlier : later.length > earlier.length;
}

function cleanMessageText(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  const safe = text.replace(/[\u0000\uD800-\uDFFF]/gu, "�");
  const prefix = Array.from(safe).slice(0, maxMessageLength).join("");
  return prefix.trim() ? prefix : Array.from(safe.trimStart()).slice(0, maxMessageLength).join("");
}

function normalizeMessage(
  event: z.output<typeof eventBody>,
  scope: EventScope,
): SlackEventEnvelope {
  if (!inLocalChannel(event, scope)) return ignored;

  if (event.type === "message" && event.subtype === "message_deleted") {
    const messageTs = event.deleted_ts;
    const versionTs = event.event_ts ?? event.ts;
    if (!messageTs || !versionTs || !follows(versionTs, messageTs)) return ignored;
    if (event.previous_message == null) {
      return { ...scope, action: "deleted", messageTs, threadTs: null, versionTs, actorId: null };
    }
    const previous = messageSnapshot.safeParse(event.previous_message);
    if (
      !previous.success ||
      !isHumanMessage(previous.data, scope) ||
      previous.data.ts !== messageTs
    ) {
      return ignored;
    }
    return {
      ...scope,
      action: "deleted",
      messageTs,
      threadTs: previous.data.thread_ts ?? messageTs,
      versionTs,
      actorId: previous.data.user,
    };
  }

  if (event.type === "message" && event.subtype === "message_changed") {
    const revised = editedMessage.safeParse(event.message);
    if (!revised.success || !isHumanMessage(revised.data, scope)) return ignored;
    const message = revised.data;
    if (message.edited.user !== message.user || !follows(message.edited.ts, message.ts))
      return ignored;

    let threadTs = message.thread_ts;
    if (event.previous_message != null) {
      const previous = messageSnapshot.safeParse(event.previous_message);
      if (
        !previous.success ||
        !isHumanMessage(previous.data, scope) ||
        previous.data.ts !== message.ts ||
        previous.data.user !== message.user ||
        previous.data.text === message.text ||
        (previous.data.thread_ts && threadTs && previous.data.thread_ts !== threadTs)
      ) {
        return ignored;
      }
      threadTs ??= previous.data.thread_ts;
    }
    const text = cleanMessageText(message.text);
    if (text === null) return ignored;
    return {
      ...scope,
      action: "edited",
      messageTs: message.ts,
      threadTs: threadTs ?? message.ts,
      versionTs: message.edited.ts,
      actorId: message.user,
      text,
    };
  }

  const { ts, user } = event;
  if (!ts || !user || event.hidden || !isHumanMessage({ ...event, ts, user }, scope))
    return ignored;
  const text = cleanMessageText(event.text);
  if (text === null) return ignored;

  return {
    ...scope,
    action: event.type === "app_mention" ? "mention" : "created",
    messageTs: ts,
    threadTs: event.thread_ts ?? ts,
    versionTs: ts,
    actorId: user,
    text,
  };
}

function isHumanMessage(message: z.output<typeof messageSnapshot>, scope: EventScope): boolean {
  return (
    inLocalChannel(message, scope) &&
    !message.subtype &&
    message.user !== "USLACKBOT" &&
    (!message.thread_ts || !follows(message.thread_ts, message.ts))
  );
}

export function parseSlackEventBody(
  body: Uint8Array,
  expectedAppId: string,
): SlackEventEnvelope | null {
  if (body.byteLength === 0 || body.byteLength > slackEventMaxBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const kind = bodyKind.safeParse(raw);
  if (!kind.success) return null;
  if (kind.data.type === "url_verification") {
    const challenge = challengeBody.safeParse(raw);
    return challenge.success ? { kind: "challenge", challenge: challenge.data.challenge } : null;
  }
  if (kind.data.type !== "event_callback") return ignored;

  const callback = eventCallback.safeParse(raw);
  if (!callback.success || callback.data.api_app_id !== expectedAppId) return null;
  const envelope = callback.data;
  if (
    envelope.team_id === null ||
    (envelope.context_team_id != null && envelope.context_team_id !== envelope.team_id) ||
    isShared(envelope)
  ) {
    return ignored;
  }
  const event = eventBody.safeParse(envelope.event);
  if (!event.success) return ignored;

  return normalizeMessage(event.data, {
    kind: "event",
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    eventId: envelope.event_id,
    channelId: event.data.channel,
  });
}
