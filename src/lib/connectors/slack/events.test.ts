import { describe, expect, it } from "vitest";
import { parseSlackEventBody, slackEventMaxBytes, verifySlackEventSignature } from "./events";

const teamId = "T1234567890";
const appId = "A1234567890";
const userId = "U1234567890";
const channelId = "C1234567890";
const messageTs = "1760000000.000031";
const threadTs = "1760000000.000020";
const versionTs = "1760000001.000051";
const eventId = "Ev_fixture-1";
const encoder = new TextEncoder();
const event = { type: "message", channel: channelId, user: userId, ts: messageTs, text: "Message" };
const scope = { kind: "event", teamId, appId, eventId, channelId };

function parse(payload: unknown) {
  return parseSlackEventBody(encoder.encode(JSON.stringify(payload)), appId);
}

function callback(body: Record<string, unknown>, fields?: Record<string, unknown>) {
  return parse({
    type: "event_callback",
    team_id: teamId,
    api_app_id: appId,
    event_id: eventId,
    event: body,
    ...fields,
  });
}

describe("Slack request signature", () => {
  const signedBody = '{"type":"url_verification", "challenge":"Wallie-fixture"}';
  const request = {
    body: encoder.encode(signedBody),
    signingSecret: "slack-test-signing-secret",
    signature: "v0=49826d5a6b5fa353afc450d11d5fdc7254b6df220155c9e9321a51f7855e5b44",
    timestamp: "1760000000",
    nowMs: 1760000000_000,
  };

  it("verifies the exact signed challenge bytes with the independently computed HMAC", () => {
    expect(verifySlackEventSignature(request)).toBe(true);
    expect(parseSlackEventBody(request.body, appId)).toEqual({
      kind: "challenge",
      challenge: "Wallie-fixture",
    });
    expect(
      verifySlackEventSignature({
        ...request,
        body: encoder.encode(signedBody.replace(", ", ",")),
      }),
    ).toBe(false);
    expect(verifySlackEventSignature({ ...request, signingSecret: "another-secret" })).toBe(false);
  });

  it("enforces both edges of the timestamp window", () => {
    expect(verifySlackEventSignature({ ...request, nowMs: request.nowMs + 300_000 })).toBe(true);
    expect(verifySlackEventSignature({ ...request, nowMs: request.nowMs - 300_000 })).toBe(true);
    expect(verifySlackEventSignature({ ...request, nowMs: request.nowMs + 300_001 })).toBe(false);
    expect(verifySlackEventSignature({ ...request, nowMs: request.nowMs - 300_001 })).toBe(false);
  });

  it("fails closed on missing or noncanonical headers and unknown signature versions", () => {
    expect(verifySlackEventSignature({ ...request, signingSecret: "" })).toBe(false);
    expect(verifySlackEventSignature({ ...request, timestamp: null })).toBe(false);
    expect(verifySlackEventSignature({ ...request, timestamp: `${request.timestamp}.0` })).toBe(
      false,
    );
    expect(verifySlackEventSignature({ ...request, signature: null })).toBe(false);
    expect(
      verifySlackEventSignature({ ...request, signature: request.signature.replace("v0=", "v1=") }),
    ).toBe(false);
    expect(verifySlackEventSignature({ ...request, signature: `${request.signature}\n` })).toBe(
      false,
    );
  });

  it("bounds the body before authenticating or parsing it", () => {
    const body = encoder.encode(signedBody.padEnd(slackEventMaxBytes + 1));
    expect(verifySlackEventSignature({ ...request, body })).toBe(false);
    expect(parseSlackEventBody(body, appId)).toBeNull();
  });
});

describe("Slack event envelopes", () => {
  it("preserves immutable app, team, channel, sender and thread IDs for a public mention", () => {
    const text = "<@U000BOT1234> hello";
    expect(callback({ ...event, type: "app_mention", text })).toEqual({
      ...scope,
      action: "mention",
      actorId: userId,
      text,
      messageTs,
      threadTs: messageTs,
      versionTs: messageTs,
    });
  });

  it("uses the same original version for message and mention copies with different event times", () => {
    const mention = callback({
      ...event,
      type: "app_mention",
      thread_ts: threadTs,
      event_ts: versionTs,
    });
    const message = callback(
      { ...event, thread_ts: threadTs, event_ts: messageTs },
      { event_id: "Ev_fixture-2" },
    );
    expect(mention).toEqual({
      ...scope,
      action: "mention",
      actorId: userId,
      text: "Message",
      messageTs,
      threadTs,
      versionTs: messageTs,
    });
    expect(message).toEqual({ ...mention, action: "created", eventId: "Ev_fixture-2" });
  });

  it.each(["C1234567891", "G1234567891"])(
    "accepts the private group message form for %s",
    (channel) => {
      expect(callback({ ...event, channel, channel_type: "group" })).toEqual({
        ...scope,
        channelId: channel,
        action: "created",
        actorId: userId,
        text: "Message",
        messageTs,
        threadTs: messageTs,
        versionTs: messageTs,
      });
    },
  );

  it("uses the nested Slack edit revision and accepts the documented absence of previous_message", () => {
    expect(
      callback({
        type: "message",
        subtype: "message_changed",
        hidden: true,
        channel: channelId,
        ts: versionTs,
        message: {
          type: "message",
          user: userId,
          text: "Revised",
          ts: messageTs,
          edited: { user: userId, ts: versionTs },
        },
      }),
    ).toEqual({
      ...scope,
      action: "edited",
      actorId: userId,
      text: "Revised",
      messageTs,
      threadTs: messageTs,
      versionTs,
    });
  });

  it("preserves known parent-thread identity and ignores metadata-only or foreign-editor revisions", () => {
    const edit = {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: channelId,
      ts: versionTs,
      message: { ...event, text: "Revised", edited: { user: userId, ts: versionTs } },
      previous_message: { ...event, thread_ts: threadTs },
    };
    expect(callback(edit)).toMatchObject({ action: "edited", threadTs });
    expect(callback({ ...edit, message: { ...edit.message, text: event.text } })).toEqual({
      kind: "ignored",
    });
    expect(
      callback({
        ...edit,
        message: { ...edit.message, edited: { user: "U0000002", ts: versionTs } },
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      callback({ ...edit, message: { ...edit.message, edited: { user: userId, ts: messageTs } } }),
    ).toEqual({ kind: "ignored" });
    expect(
      callback({ ...edit, message: { ...edit.message, thread_ts: "1760000000.000010" } }),
    ).toEqual({ kind: "ignored" });
  });

  it("accepts a bare deletion without inventing a sender or parent identity", () => {
    expect(
      callback({
        type: "message",
        subtype: "message_deleted",
        hidden: true,
        channel: channelId,
        ts: versionTs,
        deleted_ts: messageTs,
      }),
    ).toEqual({ ...scope, action: "deleted", messageTs, threadTs: null, versionTs, actorId: null });
  });

  it("captures the prior sender and parent when a matching deletion snapshot exists", () => {
    const deletion = {
      type: "message",
      subtype: "message_deleted",
      channel: channelId,
      event_ts: versionTs,
      deleted_ts: messageTs,
    };
    expect(callback({ ...deletion, previous_message: { ...event, thread_ts: threadTs } })).toEqual({
      ...scope,
      action: "deleted",
      messageTs,
      threadTs,
      versionTs,
      actorId: userId,
    });
    expect(callback({ ...deletion, previous_message: { ...event, ts: threadTs } })).toEqual({
      kind: "ignored",
    });
    expect(callback({ ...deletion, event_ts: threadTs })).toEqual({ kind: "ignored" });
  });

  it.each([
    { bot_id: "B123456" },
    { bot_profile: {} },
    { app_id: "A123456" },
    { is_bot: true },
    { user: "USLACKBOT" },
    { subtype: "bot_message" },
    { subtype: "message_replied" },
    { subtype: "thread_broadcast" },
    { subtype: "file_share" },
    { channel: "D123456" },
    { channel_type: "mpim" },
    { is_shared: true },
    { user_team: "T654321" },
    { type: "reaction_added" },
    { hidden: true },
    { ts: "1760000000.31" },
    { thread_ts: versionTs },
    { text: "  " },
  ])("acknowledges an unsupported or out-of-scope message %j without dispatch", (fields) => {
    expect(callback({ ...event, ...fields })).toEqual({ kind: "ignored" });
  });

  it("ignores shared callbacks and does not mistake install authorization metadata for the sender", () => {
    expect(callback(event, { is_ext_shared_channel: true })).toEqual({ kind: "ignored" });
    expect(callback(event, { context_team_id: "T654321" })).toEqual({ kind: "ignored" });
    expect(callback(event, { team_id: null })).toEqual({ kind: "ignored" });
    expect(
      callback(event, { authorizations: [{ team_id: teamId, user_id: "U0000002", is_bot: true }] }),
    ).toMatchObject({ actorId: userId });
    expect(parse({ type: "app_rate_limited", team_id: teamId })).toEqual({ kind: "ignored" });
  });

  it("rejects malformed bodies and callbacks for another Slack app", () => {
    expect(parseSlackEventBody(encoder.encode("{"), appId)).toBeNull();
    expect(parseSlackEventBody(new Uint8Array([0xc0, 0xaf]), appId)).toBeNull();
    expect(parse({ type: "url_verification", challenge: "" })).toBeNull();
    expect(callback(event, { api_app_id: "A0000000" })).toBeNull();
    expect(callback(event, { team_id: "wrong" })).toBeNull();
    expect(callback(event, { event_id: "" })).toBeNull();
  });

  it("keeps valid message text and bounds PostgreSQL-safe Unicode to 8,000 code points", () => {
    expect(callback({ ...event, text: " preserved\n" })).toMatchObject({ text: " preserved\n" });
    const text = `\u0000\ud800${"😀".repeat(8_000)}`;
    expect(callback({ ...event, text })).toMatchObject({ text: `��${"😀".repeat(7_998)}` });
  });
});
