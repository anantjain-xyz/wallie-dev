import { after, NextResponse } from "next/server";

import { handleApproval, handleRejection } from "@/lib/pipeline/processor";
import { openSlackView } from "@/lib/pipeline/slack-format";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { verifySlackSignature } from "@/lib/slack/verify";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { processQueuedAgentJobs } from "@/lib/wallie/service";

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
  // workspace A could approve/reject a session in workspace B simply by
  // knowing its UUID, because the handlers only gate on
  // (sessionId, version, status).
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
    let metadata: { session_id: string; version: number };
    try {
      metadata = JSON.parse(payload.view.private_metadata ?? "") as {
        session_id: string;
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
      sessionId: metadata.session_id,
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
  let actionValue: { session_id: string; version: number };

  try {
    const parsed = JSON.parse(action.value);
    if (!parsed.session_id) {
      return NextResponse.json({ error: "Invalid action value" }, { status: 400 });
    }
    actionValue = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid action value" }, { status: 400 });
  }

  if (action.action_id === "pipeline_approve") {
    const result = await handleApproval({
      expectedWorkspaceId,
      sessionId: actionValue.session_id,
      version: actionValue.version,
    });

    if (!result.success) {
      // Version mismatch / stale buttons: replace the original message
      // so the dead buttons are removed and the user sees why.
      const isStale =
        result.error?.includes("stale") ||
        result.error?.includes("version") ||
        result.error?.includes("already reviewed");
      if (isStale) {
        return NextResponse.json({
          replace_original: true,
          text: `:warning: This spec version is outdated — a newer version has been posted above.`,
        });
      }

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
      // lookup keyed by session.workspace_id, which is user-supplied and
      // would leak another workspace's token if spoofed.
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
