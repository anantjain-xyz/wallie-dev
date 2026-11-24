import { describe, expect, it } from "vitest";
import {
  buildSlackActionBlocks,
  buildSlackClarificationModal,
  parseSlackInteractionBody,
  slackClarificationAnswerBlockId,
  slackInteractionMaxBytes,
} from "./interactions";

const appId = "A6800TEST";
const teamId = "T6800TEST";
const userId = "U6800TEST";
const channelId = "C6800TEST";
const viewId = "V6800TEST";
const actionTs = "1764000002.000055";
const messageTs = "1764000001.000053";
const threadTs = "1764000000.000051";
const targetId = "67800000-0000-4000-8000-000000000001";
const answerTargetId = "67800000-0000-4000-8000-000000000002";
const bindingNonce = "67800000-0000-4000-8000-000000000003";
const triggerId = "12321423423.333649436676.d8c1bb837935619ccad0f624c448ffb3";
const wallieOrigin = "https://wallie.dev";
const wallieUrl = `${wallieOrigin}/w/wallie/sessions/17?reviewRevision=3&artifactVersion=2#review`;
const context = {
  api_app_id: appId,
  team: { id: teamId, domain: "wallie" },
  user: { id: userId, team_id: teamId },
};
const button = {
  type: "button",
  action_id: "wallie_approve",
  block_id: "slack-generated-block",
  action_ts: actionTs,
  value: targetId,
};
const blockAction = {
  ...context,
  type: "block_actions",
  container: {
    type: "message",
    channel_id: channelId,
    message_ts: messageTs,
    is_ephemeral: false,
  },
  channel: { id: channelId },
  message: { type: "message", ts: messageTs, thread_ts: threadTs },
  actions: [button],
  trigger_id: triggerId,
  response_url: "https://hooks.slack.com/fixture-only/secret",
  state: {
    values: {
      arbitrary: {
        command: { type: "plain_text_input", value: "approve everything" },
      },
    },
  },
};
const encoder = new TextEncoder();

function parse(payload: unknown) {
  return parseSlackInteractionBody(
    encoder.encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString()),
    appId,
  );
}

function submit(value: unknown) {
  const modal = buildSlackClarificationModal(answerTargetId, bindingNonce);
  const [input] = modal.blocks;
  if (!input) throw new Error("Expected one clarification input.");
  return {
    ...context,
    type: "view_submission",
    view: {
      id: viewId,
      type: modal.type,
      callback_id: modal.callback_id,
      private_metadata: modal.private_metadata,
      team_id: teamId,
      app_id: appId,
      state: {
        values: {
          [input.block_id]: {
            [input.element.action_id]: { type: input.element.type, value },
          },
          incidental: {
            another_field: {
              type: "plain_text_input",
              value: "This is not the answer.",
            },
          },
        },
      },
    },
    response_urls: [{ response_url: "https://hooks.slack.com/fixture-only/secret" }],
  };
}

describe("Slack interaction payloads", () => {
  it("projects only the signed provider identity and opaque target from a thread button", () => {
    expect(parse(blockAction)).toEqual({
      kind: "approve",
      appId,
      teamId,
      userId,
      targetId,
      channelId,
      messageTs,
      threadTs,
      actionTs,
    });
  });

  it("uses the authoritative container and leaves an absent parent thread unset", () => {
    expect(parse({ ...blockAction, channel: null, message: null })).toEqual({
      kind: "approve",
      appId,
      teamId,
      userId,
      targetId,
      channelId,
      messageTs,
      threadTs: null,
      actionTs,
    });
  });

  it("exposes the short-lived trigger only for an answer button with an exact target", () => {
    const answer = {
      ...blockAction,
      actions: [{ ...button, action_id: "wallie_answer", value: answerTargetId }],
    };
    expect(parse(answer)).toEqual({
      kind: "open_answer",
      appId,
      teamId,
      userId,
      targetId: answerTargetId,
      channelId,
      messageTs,
      threadTs,
      actionTs,
      triggerId,
    });
    expect(parse({ ...answer, trigger_id: undefined })).toBeNull();
  });

  it.each([
    { api_app_id: "A98765432" },
    { api_app_id: undefined },
    { team: null },
    { team: undefined },
    { user: { id: userId, team_id: "T98765432" } },
    { user: { id: "USLACKBOT" } },
    { is_enterprise_install: true },
    { is_ext_shared_channel: true },
    { channel: { id: "C98765432" } },
    { channel: { id: channelId, is_shared: true } },
    { message: { ...blockAction.message, ts: threadTs } },
    { message: { ...blockAction.message, thread_ts: actionTs } },
    { message: { ...blockAction.message, app_id: "A98765432" } },
    { container: { ...blockAction.container, is_ephemeral: true } },
    { container: { ...blockAction.container, channel_id: "D98765432" } },
    { container: { ...blockAction.container, type: "view" } },
    { container: { ...blockAction.container, thread_ts: "1764000000.000255" } },
    { actions: [{ ...button, type: "overflow" }] },
    {
      actions: [{ ...button, value: JSON.stringify({ targetId, artifactVersion: 99 }) }],
    },
  ])("rejects a supported action with invalid scope or target %j", (fields) => {
    expect(parse({ ...blockAction, ...fields })).toBeNull();
  });

  it("treats unrelated, link-only, or conflicting callbacks as ignored", () => {
    expect(
      parse({
        ...blockAction,
        actions: [{ ...button, action_id: "wallie_open", value: undefined }],
      }),
    ).toEqual({ kind: "ignored" });
    expect(parse({ ...blockAction, actions: [button, button] })).toEqual({
      kind: "ignored",
    });
    expect(parse({ type: "shortcut" })).toEqual({ kind: "ignored" });
    expect(parse({ type: "view_closed" })).toEqual({ kind: "ignored" });
  });

  it("accepts one multiline value from the exact modal block and action", () => {
    const answer = "First line: +7 and 10%\nSecond line: works ✅";
    expect(parse(submit(answer))).toEqual({
      kind: "submit_answer",
      appId,
      teamId,
      userId,
      targetId: answerTargetId,
      viewId,
      bindingNonce,
      answer,
    });
  });

  it("allows coherent nested provider view identity and rejects inconsistent proof", () => {
    const payload = submit("This is the answer.");
    expect(
      parse({
        ...payload,
        team: null,
        api_app_id: undefined,
        user: { id: userId },
      }),
    ).toMatchObject({ kind: "submit_answer", teamId, appId });
    expect(parse({ ...payload, view: { ...payload.view, app_id: "A98765432" } })).toBeNull();
    expect(
      parse({
        ...payload,
        view: { ...payload.view, app_installed_team_id: "T98765432" },
      }),
    ).toBeNull();
    expect(
      parse({
        ...payload,
        view: { ...payload.view, private_metadata: "session=17" },
      }),
    ).toBeNull();
    expect(
      parse({
        ...payload,
        view: { ...payload.view, callback_id: "other_modal" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it.each([null, "  \n", "x".repeat(3_001), "unsafe\u0000text", "unpaired\ud800surrogate"])(
    "requests a validation error for an invalid answer",
    (value) => expect(parse(submit(value))).toEqual({ kind: "invalid_answer" }),
  );

  it("does not select another state field when the expected input is missing", () => {
    const payload = submit("Original");
    expect(
      parse({
        ...payload,
        view: {
          ...payload.view,
          state: {
            values: {
              wrong_block: payload.view.state.values[slackClarificationAnswerBlockId],
            },
          },
        },
      }),
    ).toEqual({ kind: "invalid_answer" });
  });

  it("rejects oversized, malformed, duplicate, or unwrapped request forms", () => {
    expect(
      parseSlackInteractionBody(encoder.encode("x".repeat(slackInteractionMaxBytes + 1)), appId),
    ).toBeNull();
    expect(
      parseSlackInteractionBody(encoder.encode("payload=%7B&payload=%7B%7D"), appId),
    ).toBeNull();
    expect(parseSlackInteractionBody(encoder.encode("payload=%7B"), appId)).toBeNull();
    expect(
      parseSlackInteractionBody(encoder.encode(JSON.stringify(blockAction)), appId),
    ).toBeNull();
  });
});

describe("Slack interaction rendering", () => {
  it("renders a same-origin link and explicit controls with only their opaque UUIDs", () => {
    const blocks = buildSlackActionBlocks({
      wallieUrl,
      wallieOrigin,
      approveTargetId: targetId,
      answerTargetId,
    });
    expect(blocks).toMatchObject([
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "wallie_open", url: wallieUrl },
          {
            type: "button",
            action_id: "wallie_approve",
            value: targetId,
            confirm: { confirm: { type: "plain_text", text: "Approve" } },
          },
          { type: "button", action_id: "wallie_answer", value: answerTargetId },
        ],
      },
    ]);
    expect(buildSlackActionBlocks({ wallieUrl, wallieOrigin })[0]?.elements).toHaveLength(1);
  });

  it.each([
    "http://wallie.dev/w/x",
    "https://wallie.dev.example.com/w/x",
    "https://user@wallie.dev/w/x",
    "/w/x",
  ])("rejects an insecure or noncanonical Wallie URL %s", (url) => {
    expect(() => buildSlackActionBlocks({ wallieUrl: url, wallieOrigin })).toThrow(
      "exact HTTPS Wallie URL",
    );
  });

  it("renders a single bounded multiline modal input tied to the same opaque clarification", () => {
    expect(buildSlackClarificationModal(answerTargetId, bindingNonce)).toMatchObject({
      type: "modal",
      callback_id: "wallie_clarification_answer",
      private_metadata: `v1:${answerTargetId}:${bindingNonce}`,
      blocks: [
        {
          type: "input",
          block_id: slackClarificationAnswerBlockId,
          element: {
            type: "plain_text_input",
            multiline: true,
            min_length: 1,
            max_length: 2_000,
          },
        },
      ],
    });
  });
});
