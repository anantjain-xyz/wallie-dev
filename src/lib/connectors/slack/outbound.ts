import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { buildAppUrl } from "@/lib/app-url";
import type { ConnectorOutboundAdapter, ConnectorOutboundTarget } from "@/lib/connectors/outbound";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { exactSessionReviewHref } from "@/lib/sessions/review-link";
import type { Database } from "@/lib/supabase/database.types";

import {
  slackAppIdSchema,
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "./contracts";
import { buildSlackActionBlocks } from "./interactions";
import {
  observeSlackOutbound,
  sendSlackOutbound,
  type SlackOutboundTransportInput,
} from "./outbound-transport";

type Client = Pick<SupabaseClient<Database>, "rpc">;

const ts = z.string().regex(/^[1-9][0-9]{0,11}\.[0-9]{6}$/);
const slug = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const reviewTarget = z.object({
  stageId: z.uuid(),
  stageSlug: slug,
  artifactId: z.uuid(),
  artifactVersion: z.number().int().positive().safe(),
  reviewRevision: z.number().int().nonnegative().safe(),
  clarificationId: z.uuid().nullable(),
});
const notice = z.object({
  kind: z.enum(["progress", "outcome", "review_ready", "clarification", "card_closed"]),
  body: z.string().min(1).max(2500),
  sessionId: z.uuid(),
  reviewTarget: reviewTarget.optional(),
});
const deliveryContext = z.object({
  session_id: z.uuid(),
  session_number: z.number().int().positive().safe(),
  workspace_slug: slug,
  team_id: slackTeamIdSchema,
  app_id: slackAppIdSchema,
  bot_user_id: slackUserIdSchema,
  channel_id: slackChannelIdSchema,
  thread_ts: ts,
  encrypted_token: z.string().min(1),
  original_write_authorized_at: z.iso.datetime({ offset: true }),
  deadline_at: z.iso.datetime({ offset: true }),
  action_target_id: z.uuid().nullable(),
  review_revision: z.number().int().nonnegative().safe().nullable(),
  previous_correlation_id: z.uuid().nullable(),
  superseded: z.boolean(),
});
type DeliveryContext = z.output<typeof deliveryContext>;

async function readContext(admin: Client, target: ConnectorOutboundTarget, signal: AbortSignal) {
  const { data, error } = await admin
    .rpc("resolve_slack_connector_delivery", {
      p_delivery_id: target.correlationId,
      p_lease_id: target.leaseId,
    })
    .abortSignal(signal);
  if (error) throw new Error("Could not resolve Slack delivery authority.");
  const context = data[0] ? deliveryContext.parse(data[0]) : null;
  if (
    !context ||
    context.channel_id !== target.externalResourceId ||
    context.thread_ts !== target.externalThreadId
  )
    return null;
  return context;
}

function buildMessage(content: z.output<typeof notice>, context: DeliveryContext) {
  const href = content.reviewTarget
    ? exactSessionReviewHref(context.workspace_slug, context.session_number, {
        ...content.reviewTarget,
        reviewRevision: context.review_revision ?? content.reviewTarget.reviewRevision,
      })
    : workspaceSessionDetailPath(context.workspace_slug, context.session_number);
  const wallieUrl = buildAppUrl(href);
  const actions = buildSlackActionBlocks({
    wallieUrl: wallieUrl.href,
    wallieOrigin: wallieUrl.origin,
    ...(context.action_target_id && content.kind === "review_ready"
      ? { approveTargetId: context.action_target_id }
      : {}),
    ...(context.action_target_id && content.kind === "clarification"
      ? { answerTargetId: context.action_target_id }
      : {}),
  });
  return {
    text: `${content.body}\n${wallieUrl.href}`,
    blocks: [{ type: "section", text: { type: "plain_text", text: content.body } }, ...actions],
  };
}

export function createSlackConnectorOutboundAdapter(admin: Client): ConnectorOutboundAdapter {
  async function prepare(target: ConnectorOutboundTarget, signal: AbortSignal, sending: boolean) {
    if (target.message.operation === "linear_status") return { kind: "invalid" } as const;
    const content = notice.safeParse(target.message.content);
    if (!content.success) return { kind: "invalid" } as const;
    const ctx = await readContext(admin, target, signal);
    if (!ctx || ctx.session_id !== content.data.sessionId) return { kind: "unavailable" } as const;
    if (ctx.superseded && sending) return { kind: "invalid" } as const;

    const transport: SlackOutboundTransportInput = {
      botToken: decryptSecretValue(ctx.encrypted_token),
      botUserId: ctx.bot_user_id,
      teamId: ctx.team_id,
      channelId: ctx.channel_id,
      threadTs: ctx.thread_ts,
      correlationId: target.correlationId,
      originalWriteAuthorizedAt: ctx.original_write_authorized_at,
      deadlineAt: ctx.deadline_at,
      message: buildMessage(content.data, ctx),
      ...(target.message.operation === "edit"
        ? { replyTs: ts.parse(target.message.providerReplyId) }
        : {}),
      ...(ctx.previous_correlation_id
        ? { previousCorrelationId: ctx.previous_correlation_id }
        : {}),
      async checkAuthority() {
        const current = await readContext(admin, target, signal);
        if (!current || current.encrypted_token !== ctx.encrypted_token) {
          return "unavailable";
        }
        if (sending && (current.superseded || current.action_target_id !== ctx.action_target_id)) {
          return "superseded";
        }
        return "current";
      },
    };
    return { kind: "ready", transport, context: ctx } as const;
  }

  async function registerCard(context: DeliveryContext, messageTs: string, signal: AbortSignal) {
    if (!context.action_target_id) return true;
    const result = await admin
      .rpc("register_slack_review_card", {
        p_target_id: context.action_target_id,
        p_team_id: context.team_id,
        p_app_id: context.app_id,
        p_channel_id: context.channel_id,
        p_thread_ts: context.thread_ts,
        p_message_ts: messageTs,
      })
      .abortSignal(signal);
    return result.error === null && result.data === true;
  }

  return {
    provider: "slack",
    async send(target, signal) {
      let attempt;
      try {
        attempt = await prepare(target, signal, true);
      } catch {
        return { kind: "not_sent" };
      }
      if (attempt.kind === "invalid") return { kind: "rejected" };
      if (attempt.kind === "unavailable") return { kind: "credential_unavailable" };
      const result = await sendSlackOutbound(attempt.transport, signal);
      if (
        result.kind === "sent" &&
        !(await registerCard(attempt.context, result.providerReplyId, signal))
      ) {
        return { kind: "uncertain" };
      }
      return result;
    },
    async observe(target, signal) {
      const attempt = await prepare(target, signal, false);
      if (attempt.kind === "invalid") return { kind: "inconclusive" };
      if (attempt.kind === "unavailable") return { kind: "credential_unavailable" };
      const result = await observeSlackOutbound(attempt.transport, signal);
      if (
        result.kind === "found" &&
        !(await registerCard(attempt.context, result.providerReplyId, signal))
      ) {
        return { kind: "inconclusive" };
      }
      return result;
    },
  };
}
