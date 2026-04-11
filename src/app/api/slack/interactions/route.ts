import { after, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { handleApproval, handleRejection } from "@/lib/pipeline/processor";
import { openSlackView } from "@/lib/pipeline/slack-format";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { processQueuedAgentJobs } from "@/lib/wallie/service";

function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;

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

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Slack sends interaction payloads as application/x-www-form-urlencoded
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  let payload: {
    actions?: Array<{ action_id: string; value: string }>;
    enterprise?: { id?: string };
    team?: { id?: string };
    trigger_id?: string;
    type?: string;
    view?: {
      callback_id?: string;
      private_metadata?: string;
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    };
  };
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return NextResponse.json({ error: "Invalid payload JSON" }, { status: 400 });
  }

  // Resolve the Slack team that sent this interaction to its workspace_id.
  // Every downstream action (approve, reject, open feedback modal, submit
  // feedback) is scoped to this workspace. Without this check a user in
  // workspace A could approve/reject a pipeline_issue in workspace B simply
  // by knowing its UUID, because the handlers previously only gated on
  // (pipelineIssueId, version, status).
  //
  // Enterprise Grid fallback: payloads from a Grid org may carry only
  // enterprise.id, with team.id missing. Match the events route by falling
  // back to enterprise.id so Grid customers can still approve/reject.
  const teamId = payload.team?.id ?? payload.enterprise?.id;
  if (!teamId) {
    return NextResponse.json({ error: "Missing team id" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: slackInstall } = await admin
    .from("slack_installations")
    .select("workspace_id, bot_token_encrypted")
    .eq("team_id", teamId)
    .maybeSingle();

  if (!slackInstall) {
    return NextResponse.json({ error: "Unknown Slack workspace" }, { status: 403 });
  }

  const expectedWorkspaceId = slackInstall.workspace_id;

  // Handle modal submission (view_submission) before action dispatch
  if (payload.type === "view_submission" && payload.view?.callback_id === "pipeline_feedback") {
    let metadata: { pipeline_issue_id: string; version: number };
    try {
      metadata = JSON.parse(payload.view.private_metadata ?? "") as {
        pipeline_issue_id: string;
        version: number;
      };
    } catch {
      return NextResponse.json({ error: "Invalid view metadata" }, { status: 400 });
    }

    const feedbackText = payload.view.state?.values?.feedback_block?.feedback_input?.value ?? "";

    if (!feedbackText.trim()) {
      return NextResponse.json({
        errors: { feedback_block: "Please provide feedback on what needs to change." },
        response_action: "errors",
      });
    }

    const result = await handleRejection({
      expectedWorkspaceId,
      feedbackText: feedbackText.trim(),
      pipelineIssueId: metadata.pipeline_issue_id,
      version: metadata.version,
    });

    if (!result.success) {
      return NextResponse.json({
        errors: { feedback_block: result.error ?? "Failed to process feedback." },
        response_action: "errors",
      });
    }

    // Trigger background processing for the re-generation job
    if (!result.escalated) {
      after(async () => {
        try {
          await processQueuedAgentJobs();
        } catch (error) {
          console.error("Pipeline feedback re-generation failed", { error });
        }
      });
    }

    // Close the modal
    return NextResponse.json({ response_action: "clear" });
  }

  const actions = payload.actions as Array<{
    action_id: string;
    value: string;
  }>;

  if (!actions || actions.length === 0) {
    return NextResponse.json({ ok: true });
  }

  const action = actions[0]!;
  let actionValue: { pipeline_issue_id: string; version: number };

  try {
    actionValue = JSON.parse(action.value);
  } catch {
    return NextResponse.json({ error: "Invalid action value" }, { status: 400 });
  }

  if (action.action_id === "pipeline_approve") {
    const result = await handleApproval({
      expectedWorkspaceId,
      pipelineIssueId: actionValue.pipeline_issue_id,
      version: actionValue.version,
    });

    if (!result.success) {
      // Respond with ephemeral message about the error
      return NextResponse.json({
        replace_original: false,
        response_type: "ephemeral",
        text: result.error ?? "Approval failed.",
      });
    }

    // Update the original message to remove action buttons
    return NextResponse.json({
      replace_original: true,
      text: `:white_check_mark: Spec v${actionValue.version} approved! Moving to next phase.`,
    });
  }

  if (action.action_id === "pipeline_request_changes") {
    // For request changes, we need feedback text.
    // Open a modal to collect feedback if this is the initial button click.
    const triggerId = payload.trigger_id;

    if (triggerId) {
      // Use the bot token from the Slack team that sent the click — NOT a
      // lookup keyed by pipeline_issue.workspace_id, which is user-supplied
      // and would leak another workspace's token if spoofed.
      const botToken = decryptSecretValue(slackInstall.bot_token_encrypted);

      try {
        await openSlackView({
          botToken,
          triggerId,
          view: {
            blocks: [
              {
                block_id: "feedback_block",
                element: {
                  action_id: "feedback_input",
                  multiline: true,
                  placeholder: {
                    text: "What needs to change in this spec?",
                    type: "plain_text",
                  },
                  type: "plain_text_input",
                },
                label: { text: "Feedback", type: "plain_text" },
                type: "input",
              },
            ],
            callback_id: "pipeline_feedback",
            private_metadata: JSON.stringify(actionValue),
            submit: { text: "Submit Feedback", type: "plain_text" },
            title: { text: "Request Changes", type: "plain_text" },
            type: "modal",
          },
        });
      } catch (viewError) {
        console.error("Failed to open feedback modal", {
          error: viewError instanceof Error ? viewError.message : String(viewError),
        });
        return NextResponse.json({
          replace_original: false,
          response_type: "ephemeral",
          text: ":warning: Couldn't open the feedback form. Please try again, or ping an operator if this keeps happening.",
        });
      }
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
