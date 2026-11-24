import { z } from "zod/v4";
import {
  slackAppIdSchema,
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "./contracts";

export const slackInteractionMaxBytes = 256_000;
export const slackClarificationAnswerBlockId = "wallie_answer_input";
const answerActionId = "wallie_answer_text";
const answerCallbackId = "wallie_clarification_answer";
export const slackClarificationAnswerMaxLength = 2_000;
const targetId = z.uuid().toLowerCase();
const slackTs = z.string().regex(/^[1-9][0-9]{0,11}\.[0-9]{6}$/);
const triggerId = z.string().regex(/^[A-Za-z0-9_.-]{1,512}$/);
const enterpriseId = z.string().regex(/^E[A-Z0-9]{2,31}$/);
const identity = z.object({
  api_app_id: slackAppIdSchema.nullish(),
  team: z.object({ id: slackTeamIdSchema }).nullish(),
  user: z.object({
    id: slackUserIdSchema,
    team_id: z.union([slackTeamIdSchema, enterpriseId]).nullish(),
  }),
  enterprise: z.object({ id: enterpriseId }).nullish(),
  is_enterprise_install: z.boolean().optional(),
});
const actionKind = z.object({
  action_id: z.enum(["wallie_approve", "wallie_answer"]),
});
const buttonAction = actionKind.extend({
  type: z.literal("button"),
  value: targetId,
  action_ts: slackTs,
});
const blockActions = identity.extend({
  actions: z.tuple([buttonAction]),
  trigger_id: triggerId.optional(),
  container: z.object({
    type: z.literal("message"),
    channel_id: slackChannelIdSchema,
    message_ts: slackTs,
    thread_ts: slackTs.nullish(),
    is_ephemeral: z.boolean().optional(),
    is_app_unfurl: z.boolean().optional(),
  }),
  channel: z.object({ id: slackChannelIdSchema, is_shared: z.boolean().optional() }).nullish(),
  message: z
    .object({
      type: z.literal("message").optional(),
      ts: slackTs,
      thread_ts: slackTs.nullish(),
      app_id: slackAppIdSchema.nullish(),
    })
    .nullish(),
  is_ext_shared_channel: z.boolean().optional(),
});
const submission = identity.extend({
  view: z.object({
    id: z.string().regex(/^V[A-Z0-9]{2,63}$/),
    type: z.literal("modal"),
    callback_id: z.literal(answerCallbackId),
    private_metadata: targetId,
    app_id: slackAppIdSchema.nullish(),
    team_id: slackTeamIdSchema.nullish(),
    app_installed_team_id: slackTeamIdSchema.nullish(),
    state: z.unknown(),
  }),
});
const clarificationAnswer = z.object({
  values: z.object({
    [slackClarificationAnswerBlockId]: z.object({
      [answerActionId]: z.object({
        type: z.literal("plain_text_input"),
        value: z
          .string()
          .refine(
            (value) =>
              value.trim().length > 0 &&
              !/[\u0000\uD800-\uDFFF]/u.test(value) &&
              Array.from(value).length <= slackClarificationAnswerMaxLength,
          ),
      }),
    }),
  }),
});
const envelope = z.object({
  type: z.string().min(1),
  actions: z.array(z.unknown()).optional(),
  view: z.object({ callback_id: z.string().optional() }).nullish(),
});

type Identity = { appId: string; teamId: string; userId: string };
type Button = Identity & {
  targetId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  actionTs: string;
};

export type SlackInteraction =
  | { kind: "ignored" }
  | (Button & { kind: "approve" })
  | (Button & { kind: "open_answer"; triggerId: string })
  | (Identity & {
      kind: "submit_answer";
      targetId: string;
      viewId: string;
      answer: string;
    })
  | { kind: "invalid_answer" };

function resolveIdentity(
  data: z.output<typeof identity>,
  expectedAppId: string,
  view?: z.output<typeof submission>["view"],
): Identity | null {
  const appId = data.api_app_id ?? view?.app_id;
  const teamId = data.team?.id ?? view?.app_installed_team_id ?? view?.team_id;
  if (
    !appId ||
    appId !== expectedAppId ||
    (view?.app_id && view.app_id !== appId) ||
    !teamId ||
    (view?.team_id && view.team_id !== teamId) ||
    (view?.app_installed_team_id && view.app_installed_team_id !== teamId) ||
    (data.user.team_id &&
      data.user.team_id !== teamId &&
      data.user.team_id !== data.enterprise?.id) ||
    data.user.id === "USLACKBOT" ||
    data.is_enterprise_install
  ) {
    return null;
  }
  return { appId, teamId, userId: data.user.id };
}

function isAfter(later: string, earlier: string): boolean {
  return later.length === earlier.length ? later > earlier : later.length > earlier.length;
}

function readButton(raw: unknown, expectedAppId: string): SlackInteraction | null {
  const result = blockActions.safeParse(raw);
  if (!result.success) return null;
  const data = result.data;
  const scope = resolveIdentity(data, expectedAppId);
  const channelId = data.container.channel_id;
  const messageTs = data.container.message_ts;
  const threadTs = data.message?.thread_ts ?? data.container.thread_ts ?? null;
  const [action] = data.actions;
  if (
    !scope ||
    data.container.is_ephemeral ||
    data.container.is_app_unfurl ||
    data.is_ext_shared_channel ||
    (data.channel && (data.channel.id !== channelId || data.channel.is_shared)) ||
    (data.message && data.message.ts !== messageTs) ||
    (data.message?.app_id && data.message.app_id !== scope.appId) ||
    (data.container.thread_ts &&
      data.message?.thread_ts &&
      data.container.thread_ts !== data.message.thread_ts) ||
    (threadTs && isAfter(threadTs, messageTs)) ||
    isAfter(messageTs, action.action_ts)
  ) {
    return null;
  }
  const button = {
    ...scope,
    targetId: action.value,
    channelId,
    messageTs,
    threadTs,
    actionTs: action.action_ts,
  };
  if (action.action_id === "wallie_approve") return { ...button, kind: "approve" };
  return data.trigger_id ? { ...button, kind: "open_answer", triggerId: data.trigger_id } : null;
}

function readAnswer(raw: unknown, expectedAppId: string): SlackInteraction | null {
  const result = submission.safeParse(raw);
  if (!result.success) return null;
  const { view } = result.data;
  const scope = resolveIdentity(result.data, expectedAppId, view);
  if (!scope) return null;
  const answer = clarificationAnswer.safeParse(view.state);
  if (!answer.success) return { kind: "invalid_answer" };
  return {
    ...scope,
    kind: "submit_answer",
    targetId: view.private_metadata,
    viewId: view.id,
    answer: answer.data.values[slackClarificationAnswerBlockId][answerActionId].value,
  };
}

// Accept only the already authenticated, unmodified form body from Slack.
export function parseSlackInteractionBody(
  body: Uint8Array,
  expectedAppId: string,
): SlackInteraction | null {
  if (body.byteLength === 0 || body.byteLength > slackInteractionMaxBytes) return null;
  let raw: unknown;
  try {
    const fields = new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    const [payload, ...duplicates] = fields.getAll("payload");
    if (!payload || duplicates.length > 0) return null;
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const kind = envelope.safeParse(raw);
  if (!kind.success) return null;
  if (kind.data.type === "block_actions") {
    const actions = kind.data.actions;
    if (actions?.length !== 1 || !actionKind.safeParse(actions[0]).success)
      return { kind: "ignored" };
    return readButton(raw, expectedAppId);
  }
  if (kind.data.type === "view_submission" && kind.data.view?.callback_id === answerCallbackId) {
    return readAnswer(raw, expectedAppId);
  }
  return { kind: "ignored" };
}

function plainText(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

type ActionButton = {
  type: "button";
  text: ReturnType<typeof plainText>;
} & (
  | { action_id: "wallie_open"; url: string }
  | { action_id: "wallie_answer"; value: string }
  | {
      action_id: "wallie_approve";
      value: string;
      style: "primary";
      confirm: Record<"title" | "text" | "confirm" | "deny", ReturnType<typeof plainText>>;
    }
);

function exactWallieUrl(wallieUrl: string, wallieOrigin: string): string {
  const link = URL.parse(wallieUrl);
  const app = URL.parse(wallieOrigin);
  if (
    !link ||
    !app ||
    link.protocol !== "https:" ||
    app.protocol !== "https:" ||
    link.origin !== app.origin ||
    link.username ||
    link.password ||
    link.href.length > 3_000
  ) {
    throw new Error("Slack action links require an exact HTTPS Wallie URL.");
  }
  return link.href;
}

export function buildSlackActionBlocks({
  wallieUrl,
  wallieOrigin,
  approveTargetId,
  answerTargetId,
}: {
  wallieUrl: string;
  wallieOrigin: string;
  approveTargetId?: string;
  answerTargetId?: string;
}): Array<{ type: "actions"; elements: ActionButton[] }> {
  const elements: ActionButton[] = [
    {
      type: "button",
      text: plainText("Open in Wallie"),
      action_id: "wallie_open",
      url: exactWallieUrl(wallieUrl, wallieOrigin),
    },
  ];
  if (approveTargetId !== undefined) {
    elements.push({
      type: "button",
      text: plainText("Approve artifact"),
      action_id: "wallie_approve",
      value: targetId.parse(approveTargetId),
      style: "primary",
      confirm: {
        title: plainText("Approve this artifact?"),
        text: plainText("Your approval will be recorded in Wallie."),
        confirm: plainText("Approve"),
        deny: plainText("Cancel"),
      },
    });
  }
  if (answerTargetId !== undefined) {
    elements.push({
      type: "button",
      text: plainText("Answer clarification"),
      action_id: "wallie_answer",
      value: targetId.parse(answerTargetId),
    });
  }
  return [{ type: "actions", elements }];
}

export function buildSlackClarificationModal(clarificationTargetId: string) {
  return {
    type: "modal",
    callback_id: answerCallbackId,
    private_metadata: targetId.parse(clarificationTargetId),
    title: plainText("Answer clarification"),
    submit: plainText("Send answer"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: slackClarificationAnswerBlockId,
        label: plainText("Your answer"),
        element: {
          type: "plain_text_input",
          action_id: answerActionId,
          multiline: true,
          min_length: 1,
          max_length: slackClarificationAnswerMaxLength,
        },
      },
    ],
  };
}
