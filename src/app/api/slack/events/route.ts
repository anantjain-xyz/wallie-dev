import { parseServerEnv } from "@/env/server";
import { slackAppIdSchema } from "@/lib/connectors/slack/contracts";
import {
  parseSlackEventBody,
  slackEventMaxBytes,
  verifySlackEventSignature,
} from "@/lib/connectors/slack/events";
import { readBoundedJsonBytes } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const preferredRegion = "home";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const deadline = AbortSignal.timeout(2_600);
  const env = parseServerEnv();
  const appId = slackAppIdSchema.safeParse(env.SLACK_APP_ID);
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!appId.success || !signingSecret) {
    return Response.json({ error: "Slack events are unavailable." }, { status: 503, headers });
  }
  const body = await readBoundedJsonBytes(
    request,
    slackEventMaxBytes,
    AbortSignal.any([deadline, AbortSignal.timeout(1_000)]),
  );
  if (!body.ok) {
    const status =
      body.code === "unsupported_media_type" ? 415 : body.code === "request_too_large" ? 413 : 400;
    return Response.json({ error: "Invalid Slack request body." }, { status, headers });
  }
  if (
    !verifySlackEventSignature({
      body: body.bytes,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      signingSecret,
    })
  ) {
    return Response.json({ error: "Invalid Slack event signature." }, { status: 401, headers });
  }
  const parsed = parseSlackEventBody(body.bytes, appId.data);
  if (!parsed) return Response.json({ error: "Invalid Slack event." }, { status: 400, headers });
  if (parsed.kind === "challenge")
    return Response.json({ challenge: parsed.challenge }, { headers });
  if (parsed.kind === "ignored") return new Response(null, { headers });

  // Acknowledge only after the scoped event is durable. The worker verifies current
  // channel membership before dispatching a session command.
  const { error } = await createSupabaseAdminClient()
    .rpc("enqueue_slack_connector_event", {
      p_team_id: parsed.teamId,
      p_app_id: parsed.appId,
      p_channel_id: parsed.channelId,
      p_event_id: parsed.eventId,
      p_action: parsed.action,
      p_message_ts: parsed.messageTs,
      p_version_ts: parsed.versionTs,
      ...(parsed.threadTs ? { p_thread_ts: parsed.threadTs } : {}),
      ...(parsed.actorId ? { p_actor_id: parsed.actorId } : {}),
      ...(parsed.action !== "deleted" ? { p_body: parsed.text } : {}),
    })
    .abortSignal(deadline);
  if (error) {
    return Response.json(
      { error: "Could not accept Slack event." },
      {
        status: error.code === "PT409" ? 409 : 503,
        headers,
      },
    );
  }
  return new Response(null, { headers });
}
