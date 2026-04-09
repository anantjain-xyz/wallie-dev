import { after, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { handleApproval, handleRejection } from "@/lib/pipeline/processor";
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

  const payload = JSON.parse(payloadStr);
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
    const triggerId = payload.trigger_id as string;

    if (triggerId) {
      // Open a modal for feedback input
      const { decryptSecretValue } = await import("@/lib/secrets/crypto");
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const admin = createSupabaseAdminClient();

      // Get bot token from the workspace associated with this pipeline issue
      const { data: pipelineIssue } = await admin
        .from("pipeline_issues")
        .select("workspace_id")
        .eq("id", actionValue.pipeline_issue_id)
        .maybeSingle();

      if (pipelineIssue) {
        const { data: slackInstall } = await admin
          .from("slack_installations")
          .select("bot_token_encrypted")
          .eq("workspace_id", pipelineIssue.workspace_id)
          .maybeSingle();

        if (slackInstall) {
          const botToken = decryptSecretValue(slackInstall.bot_token_encrypted);

          await fetch("https://slack.com/api/views.open", {
            body: JSON.stringify({
              trigger_id: triggerId,
              view: {
                callback_id: "pipeline_feedback",
                private_metadata: JSON.stringify(actionValue),
                submit: { text: "Submit Feedback", type: "plain_text" },
                title: { text: "Request Changes", type: "plain_text" },
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
                type: "modal",
              },
            }),
            headers: {
              Authorization: `Bearer ${botToken}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          });
        }
      }
    }

    return NextResponse.json({ ok: true });
  }

  // Handle modal submission (view_submission)
  if (payload.type === "view_submission" && payload.view?.callback_id === "pipeline_feedback") {
    const metadata = JSON.parse(payload.view.private_metadata) as {
      pipeline_issue_id: string;
      version: number;
    };

    const feedbackText = payload.view.state?.values?.feedback_block?.feedback_input?.value ?? "";

    if (!feedbackText.trim()) {
      return NextResponse.json({
        response_action: "errors",
        errors: { feedback_block: "Please provide feedback on what needs to change." },
      });
    }

    const result = await handleRejection({
      feedbackText: feedbackText.trim(),
      pipelineIssueId: metadata.pipeline_issue_id,
      version: metadata.version,
    });

    if (!result.success) {
      return NextResponse.json({
        response_action: "errors",
        errors: { feedback_block: result.error ?? "Failed to process feedback." },
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

  return NextResponse.json({ ok: true });
}
