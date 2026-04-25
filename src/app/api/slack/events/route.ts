import { after, NextResponse } from "next/server";

import { fetchLinearIssue } from "@/lib/linear/client";
import { PIPELINE_JOB_TYPE, buildPipelineDedupeKey } from "@/lib/pipeline/types";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { verifySlackSignature } from "@/lib/slack/verify";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { processQueuedAgentJobs } from "@/lib/wallie/service";

const LINEAR_URL_REGEX = /https:\/\/linear\.app\/[a-zA-Z0-9-]+\/issue\/([A-Z]+-\d+)/;

function extractLinearUrl(text: string): { issueId: string; url: string } | null {
  const match = text.match(LINEAR_URL_REGEX);
  if (!match) return null;
  return { issueId: match[1]!, url: match[0]! };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Verify signature before doing anything else, including url_verification.
  // The challenge echo is harmless, but answering it without a signature check
  // lets any unauthenticated caller confirm the endpoint is alive and reflect
  // arbitrary JSON back. Slack signs url_verification the same as other events.
  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Slack URL verification challenge — respond after signature verification.
  try {
    const payload = JSON.parse(rawBody);
    if (payload.type === "url_verification") {
      return NextResponse.json({ challenge: payload.challenge });
    }
  } catch {
    // Not JSON, continue
  }

  // A signed-but-malformed body should NOT throw 500, because Slack would
  // retry up to 3x on non-2xx responses. Ack with ok:true and drop.
  let payload: {
    enterprise_id?: string;
    event?: Record<string, unknown>;
    team_id?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }
  const event = payload.event;

  if (!event) {
    return NextResponse.json({ ok: true });
  }

  // Bot message guard: drop bot messages immediately
  if (event.bot_id) {
    return NextResponse.json({ ok: true });
  }

  // Only handle app_mention events
  if (event.type !== "app_mention") {
    return NextResponse.json({ ok: true });
  }

  // Enterprise Grid fallback: top-level events from a Grid org may omit
  // team_id and only carry enterprise_id. Without this fallback the
  // installation lookup would fail and Grid customers would silently lose
  // their mentions.
  const teamId = (payload.team_id as string | undefined) ?? payload.enterprise_id;
  if (!teamId) {
    return NextResponse.json({ ok: true });
  }
  const channelId = event.channel as string;
  const messageTs = event.ts as string;
  const threadTs = (event.thread_ts as string) ?? messageTs;
  const text = event.text as string;

  // Extract Linear URL from mention text
  const linearInfo = extractLinearUrl(text);

  // Ack Slack immediately — all remaining work (DB queries, Linear API,
  // session creation, job processing) runs in after() so we never risk
  // blowing Slack's 3-second response budget on a cold start.
  after(async () => {
    try {
      await handleAppMention({ teamId, channelId, threadTs, text, linearInfo });
    } catch (error) {
      console.error("Slack app_mention background handler failed", { error });
    }
  });

  return NextResponse.json({ ok: true });
}

// --- Background handler ---

async function handleAppMention(ctx: {
  teamId: string;
  channelId: string;
  threadTs: string;
  text: string;
  linearInfo: { issueId: string; url: string } | null;
}) {
  const { teamId, channelId, threadTs, linearInfo } = ctx;
  const admin = createSupabaseAdminClient();

  const { data: slackInstall } = await admin
    .from("slack_installations")
    .select("workspace_id, bot_token_encrypted")
    .eq("team_id", teamId)
    .maybeSingle();

  if (!slackInstall) {
    console.error("Slack event from unknown team", { teamId });
    return;
  }

  const workspaceId = slackInstall.workspace_id;

  async function postSlackReply(message: string) {
    try {
      const botToken = decryptSecretValue(slackInstall!.bot_token_encrypted);
      await fetch("https://slack.com/api/chat.postMessage", {
        body: JSON.stringify({
          channel: channelId,
          text: message,
          thread_ts: threadTs,
        }),
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    } catch (postError) {
      console.error("Failed to post Slack reply", { error: postError });
    }
  }

  if (!linearInfo) {
    await postSlackReply(
      "Mention me with a Linear issue URL and I'll generate a product spec for it. Example: `@wallie https://linear.app/team/issue/TEAM-123`",
    );
    return;
  }

  // Check for existing session with this Linear issue ID. If we already
  // accepted this issue and the row is in a non-rejected state, dedup. If the
  // row is in 'rejected' state, treat the new mention as an explicit retry
  // request: drop the old session and let the rest of the flow create a
  // fresh one. Recovers from the wedged state where the original mention was
  // rejected and the user @mentions again.
  const { data: existingSession } = await admin
    .from("sessions")
    .select("id, phase_status")
    .eq("workspace_id", workspaceId)
    .eq("linear_issue_id", linearInfo.issueId)
    .maybeSingle();

  if (existingSession) {
    if (existingSession.phase_status === "rejected") {
      await admin.from("sessions").delete().eq("id", existingSession.id);
    } else {
      return;
    }
  }

  // Load Linear API key for the workspace and fetch the real issue.
  const { data: linearApiKeyRow } = await admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", workspaceId)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();

  if (!linearApiKeyRow) {
    await postSlackReply(
      ":warning: Wallie can't read Linear yet — set `LINEAR_API_KEY` in workspace settings.",
    );
    return;
  }

  let linearIssue;
  try {
    const linearApiKey = decryptSecretValue(linearApiKeyRow.encrypted_value);
    linearIssue = await fetchLinearIssue(linearApiKey, linearInfo.issueId);
  } catch (linearError) {
    console.error("Linear fetch failed", { error: linearError, issueId: linearInfo.issueId });
    await postSlackReply(
      `:warning: Couldn't fetch \`${linearInfo.issueId}\` from Linear. Check the Linear API key and that the issue is reachable.`,
    );
    return;
  }

  // Load wallie system member for this workspace
  const { data: wallieMember } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "system")
    .eq("username", "wallie")
    .maybeSingle();

  const { data: sessionNumber } = await admin.rpc("next_session_number", {
    target_workspace_id: workspaceId,
  });

  const promptMd = linearIssue.description
    ? `${linearIssue.description}\n\n---\nImported from Linear: ${linearIssue.url}`
    : `Imported from Linear: ${linearIssue.url}`;

  // Sessions pin to the workspace's default pipeline + its first stage.
  const { data: defaultPipeline } = await admin
    .from("pipelines")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  const { data: firstStage } = defaultPipeline
    ? await admin
        .from("pipeline_stages")
        .select("id")
        .eq("pipeline_id", defaultPipeline.id)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null as { id: string } | null };

  if (!defaultPipeline || !firstStage) {
    return NextResponse.json(
      { error: "Workspace has no default pipeline configured." },
      { status: 500 },
    );
  }

  const { data: sessionRow, error: sessionError } = await admin
    .from("sessions")
    .insert({
      creator_member_id: wallieMember?.id ?? null,
      current_stage_id: firstStage.id,
      linear_issue_id: linearInfo.issueId,
      linear_issue_url: linearInfo.url,
      number: sessionNumber ?? 1,
      phase_status: "agent_generating",
      pipeline_id: defaultPipeline.id,
      prompt_md: promptMd,
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      title: linearIssue.title,
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  if (sessionError || !sessionRow) {
    const isDedupe = sessionError && "code" in sessionError && sessionError.code === "23505";
    if (!isDedupe) {
      console.error("Failed to create session", { error: sessionError });
    }
    return;
  }

  // Enqueue pipeline job keyed on the session — processor.ts resolves
  // the session directly via agent_jobs.session_id.
  const { data: newJob, error: jobError } = await admin
    .from("agent_jobs")
    .insert({
      dedupe_key: buildPipelineDedupeKey(linearInfo.issueId),
      job_type: PIPELINE_JOB_TYPE,
      requested_by_member_id: wallieMember?.id ?? null,
      session_id: sessionRow.id,
      trigger_type: "slack_mention",
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  if (jobError || !newJob) {
    // The sessions row already exists in `agent_generating` state but no
    // worker will ever pick it up. Roll the status back so a future mention
    // can retry cleanly instead of silently wedging.
    console.error("Failed to enqueue pipeline agent_job", { error: jobError });
    await admin.from("sessions").update({ phase_status: "rejected" }).eq("id", sessionRow.id);
    return;
  }

  // Process the queued job immediately.
  try {
    await processQueuedAgentJobs({ requestedJobId: newJob.id });
  } catch (error) {
    console.error("Pipeline job processing failed", { error, jobId: newJob.id });
  }
}
