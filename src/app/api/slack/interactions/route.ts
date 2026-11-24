import { z } from "zod/v4";
import { parseServerEnv } from "@/env/server";
import { slackAppIdSchema } from "@/lib/connectors/slack/contracts";
import { verifySlackEventSignature } from "@/lib/connectors/slack/events";
import {
  parseSlackInteractionBody,
  slackClarificationAnswerBlockId,
  slackClarificationAnswerMaxLength,
  slackInteractionMaxBytes,
  type SlackInteraction,
} from "@/lib/connectors/slack/interactions";
import { openSlackClarificationModal } from "@/lib/connectors/slack/review-provider";
import { readBoundedRequestBytes } from "@/lib/http/bounded-json-body";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const preferredRegion = "home";

const headers = { "Cache-Control": "no-store" };
const modalContexts = z
  .array(z.object({ modal_context_id: z.uuid(), encrypted_token: z.string().min(1) }))
  .max(1);
const actionDecision = z.enum(["queued", "replayed", "denied", "stale"]);
type Admin = ReturnType<typeof createSupabaseAdminClient>;

function acknowledge() {
  return new Response(null, { headers });
}

function unavailable() {
  return Response.json({ error: "Slack interactions are unavailable." }, { status: 503, headers });
}

function answerError(message: string) {
  return Response.json(
    {
      response_action: "errors",
      errors: { [slackClarificationAnswerBlockId]: message },
    },
    { headers },
  );
}

async function openAnswer(
  admin: Admin,
  action: Extract<SlackInteraction, { kind: "open_answer" }>,
  deadline: AbortSignal,
) {
  const { data, error } = await admin
    .rpc("prepare_slack_clarification_modal", {
      p_target_id: action.targetId,
      p_team_id: action.teamId,
      p_app_id: action.appId,
      p_actor_id: action.userId,
      p_channel_id: action.channelId,
      p_message_ts: action.messageTs,
      ...(action.threadTs ? { p_thread_ts: action.threadTs } : {}),
    })
    .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(550)]));
  if (error) return unavailable();
  const contexts = modalContexts.safeParse(data);
  if (!contexts.success) return unavailable();
  const [context] = contexts.data;
  if (!context) return acknowledge();

  const viewId = await openSlackClarificationModal({
    botAccessToken: decryptSecretValue(context.encrypted_token),
    targetId: context.modal_context_id,
    triggerId: action.triggerId,
    signal: deadline,
  });
  // Reserve a short window after Slack opens the modal to bind the returned view.
  const registration = await admin
    .rpc("register_slack_clarification_view", {
      p_modal_context_id: context.modal_context_id,
      p_view_id: viewId,
    })
    .abortSignal(AbortSignal.timeout(200));
  return registration.error || registration.data !== true ? unavailable() : acknowledge();
}

async function queueAction(
  admin: Admin,
  action: Extract<SlackInteraction, { kind: "approve" | "submit_answer" }>,
  deadline: AbortSignal,
) {
  const { data, error } = await admin
    .rpc("queue_slack_review_action", {
      p_context_id: action.targetId,
      p_team_id: action.teamId,
      p_app_id: action.appId,
      p_actor_id: action.userId,
      ...(action.kind === "approve"
        ? {
            p_action: "approve",
            p_delivery_key: `approve:${action.actionTs}`,
            p_channel_id: action.channelId,
            p_message_ts: action.messageTs,
            ...(action.threadTs ? { p_thread_ts: action.threadTs } : {}),
          }
        : {
            p_action: "answer",
            p_delivery_key: `answer:${action.viewId}`,
            p_view_id: action.viewId,
            p_answer: action.answer,
          }),
    })
    .abortSignal(deadline);
  const decision = actionDecision.safeParse(data);
  if (error || !decision.success) return unavailable();
  if (
    action.kind === "submit_answer" &&
    (decision.data === "denied" || decision.data === "stale")
  ) {
    return answerError("This clarification is unavailable. Open Wallie to see its current state.");
  }
  return acknowledge();
}

export async function POST(request: Request) {
  const deadline = AbortSignal.timeout(2_700);
  const env = parseServerEnv();
  const appId = slackAppIdSchema.safeParse(env.SLACK_APP_ID);
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!appId.success || !signingSecret) return unavailable();

  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return Response.json({ error: "Invalid Slack request body." }, { status: 415, headers });
  }
  const body = await readBoundedRequestBytes(
    request,
    slackInteractionMaxBytes,
    AbortSignal.timeout(450),
  );
  if (!body.ok) {
    return Response.json(
      { error: "Invalid Slack request body." },
      {
        status: body.code === "request_too_large" ? 413 : 400,
        headers,
      },
    );
  }
  if (
    !verifySlackEventSignature({
      body: body.bytes,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      signingSecret,
    })
  ) {
    return Response.json(
      { error: "Invalid Slack interaction signature." },
      { status: 401, headers },
    );
  }

  const action = parseSlackInteractionBody(body.bytes, appId.data);
  if (!action)
    return Response.json({ error: "Invalid Slack interaction." }, { status: 400, headers });
  if (action.kind === "ignored") return acknowledge();
  if (action.kind === "invalid_answer")
    return answerError(
      `Enter an answer between 1 and ${slackClarificationAnswerMaxLength.toLocaleString("en-US")} characters.`,
    );

  try {
    const admin = createSupabaseAdminClient();
    return await (action.kind === "open_answer"
      ? openAnswer(admin, action, deadline)
      : queueAction(admin, action, deadline));
  } catch {
    return unavailable();
  }
}
