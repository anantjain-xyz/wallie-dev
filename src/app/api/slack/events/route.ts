import { after, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { processQueuedAgentJobs } from "@/lib/wallie/service";
import { PIPELINE_JOB_TYPE, buildPipelineDedupeKey } from "@/lib/pipeline/types";

const LINEAR_URL_REGEX = /https:\/\/linear\.app\/[a-zA-Z0-9-]+\/issue\/([A-Z]+-\d+)/;

function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac("sha256", secret).update(sigBasestring).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

function extractLinearUrl(text: string): { issueId: string; url: string } | null {
  const match = text.match(LINEAR_URL_REGEX);
  if (!match) return null;
  return { issueId: match[1]!, url: match[0]! };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Slack URL verification challenge (no signature check needed for initial setup)
  try {
    const payload = JSON.parse(rawBody);
    if (payload.type === "url_verification") {
      return NextResponse.json({ challenge: payload.challenge });
    }
  } catch {
    // Not JSON, continue
  }

  // Verify signature
  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // A signed-but-malformed body should NOT throw 500, because Slack would
  // retry up to 3x on non-2xx responses. Ack with ok:true and drop.
  let payload: { event?: Record<string, unknown>; team_id?: string };
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

  const teamId = payload.team_id as string;
  const channelId = event.channel as string;
  const messageTs = event.ts as string;
  const threadTs = (event.thread_ts as string) ?? messageTs;
  const text = event.text as string;

  // Extract Linear URL from mention text
  const linearInfo = extractLinearUrl(text);

  if (!linearInfo) {
    // No Linear URL found, respond with help text
    const admin = createSupabaseAdminClient();
    const slackInstall = await admin
      .from("slack_installations")
      .select("bot_token_encrypted, workspace_id")
      .eq("team_id", teamId)
      .maybeSingle();

    if (slackInstall.data) {
      const { decryptSecretValue } = await import("@/lib/secrets/crypto");
      const botToken = decryptSecretValue(slackInstall.data.bot_token_encrypted);

      await fetch("https://slack.com/api/chat.postMessage", {
        body: JSON.stringify({
          channel: channelId,
          text: "Mention me with a Linear issue URL and I'll generate a product spec for it. Example: `@wallie https://linear.app/team/issue/TEAM-123`",
          thread_ts: threadTs,
        }),
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    }

    return NextResponse.json({ ok: true });
  }

  // Look up workspace from Slack team_id
  const admin = createSupabaseAdminClient();
  const { data: slackInstall } = await admin
    .from("slack_installations")
    .select("workspace_id")
    .eq("team_id", teamId)
    .maybeSingle();

  if (!slackInstall) {
    console.error("Slack event from unknown team", { teamId });
    return NextResponse.json({ ok: true });
  }

  const workspaceId = slackInstall.workspace_id;

  // Check for existing pipeline_issue with this Linear issue ID (dedup)
  const { data: existingPipeline } = await admin
    .from("pipeline_issues")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("linear_issue_id", linearInfo.issueId)
    .maybeSingle();

  if (existingPipeline) {
    // Already tracking this issue. Don't create a duplicate.
    return NextResponse.json({ ok: true });
  }

  // Load wallie system member for this workspace
  const { data: wallieMember } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "system")
    .eq("username", "wallie")
    .maybeSingle();

  // Create pipeline anchor: thin issues row from Linear data
  const { data: issueNumber } = await admin.rpc("next_issue_number", {
    target_workspace_id: workspaceId,
  });

  const { data: anchorIssue, error: issueError } = await admin
    .from("issues")
    .insert({
      creator_member_id: wallieMember?.id ?? null,
      description_md: `Imported from Linear: ${linearInfo.url}`,
      number: issueNumber ?? 1,
      title: `[Pipeline] ${linearInfo.issueId}`,
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  if (issueError || !anchorIssue) {
    console.error("Failed to create pipeline anchor issue", { error: issueError });
    return NextResponse.json({ ok: true });
  }

  // Create pipeline_issues row
  const { data: pipelineIssue, error: pipelineError } = await admin
    .from("pipeline_issues")
    .insert({
      issue_id: anchorIssue.id,
      linear_issue_id: linearInfo.issueId,
      linear_issue_url: linearInfo.url,
      phase: "product",
      phase_status: "agent_generating",
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  if (pipelineError || !pipelineIssue) {
    // 23505 = unique_violation. A concurrent mention raced us and already
    // created the pipeline_issue for this (workspace_id, linear_issue_id).
    // Treat it as a silent dedup hit: the other request will enqueue the job.
    if (pipelineError && "code" in pipelineError && pipelineError.code === "23505") {
      return NextResponse.json({ ok: true });
    }
    console.error("Failed to create pipeline_issue", { error: pipelineError });
    return NextResponse.json({ ok: true });
  }

  // Enqueue pipeline job
  const { data: newJob } = await admin
    .from("agent_jobs")
    .insert({
      dedupe_key: buildPipelineDedupeKey(linearInfo.issueId),
      issue_id: anchorIssue.id,
      job_type: PIPELINE_JOB_TYPE,
      requested_by_member_id: wallieMember?.id ?? null,
      trigger_type: "slack_mention",
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  // Trigger background processing
  if (newJob) {
    after(async () => {
      try {
        await processQueuedAgentJobs({ requestedJobId: newJob.id });
      } catch (error) {
        console.error("Pipeline job processing failed", { error, jobId: newJob.id });
      }
    });
  }

  return NextResponse.json({ ok: true });
}
