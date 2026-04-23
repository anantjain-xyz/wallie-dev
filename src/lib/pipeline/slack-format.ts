import "server-only";

import type { PipelineStage } from "@/features/sessions/types";

// Slack mrkdwn escape: `<url|label>` is rendered as a clickable link and
// `<!channel>` etc are control sequences. LLM-generated artifact text flows
// into mrkdwn sections, so any unescaped `<` allows a hostile prompt to plant
// phishing links in the reviewer channel even if the LLM ignores the
// injection attempt and simply quotes the hostile string verbatim. Slack's
// documented escape rule: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. Order
// matters — escape `&` first so we don't double-escape.
export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// One generic awaiting-review block used for every stage. Replaces the old
// per-phase formatters (formatSpecBlocks, formatSpecDiffBlocks,
// formatPreScreenFailBlocks) — the user-facing surface is "review the
// markdown the agent produced and approve/request changes."
export function formatStageReviewBlocks(input: {
  artifactPreviewMd: string;
  linearUrl: string | null;
  nextStage: Pick<PipelineStage, "name"> | null;
  sessionId: string;
  stage: Pick<PipelineStage, "name">;
  version: number;
}): Record<string, unknown>[] {
  const esc = escapeMrkdwn;

  // Cap the preview so a long artifact doesn't break the Slack message limit
  // (3000 char per text block). Reviewer can always click into the web UI.
  const preview =
    input.artifactPreviewMd.length > 2400
      ? input.artifactPreviewMd.slice(0, 2400) + "\n…"
      : input.artifactPreviewMd;

  const nextLabel = input.nextStage?.name ?? "completion";
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        emoji: true,
        text: `${input.stage.name} — v${input.version}`,
        type: "plain_text",
      },
      type: "header",
    },
    {
      text: {
        text: `Approve to advance this session from *${esc(input.stage.name)}* to *${esc(nextLabel)}*.`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: esc(preview),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];

  if (input.linearUrl) {
    blocks.push({
      elements: [
        {
          text: `<${input.linearUrl}|View in Linear>`,
          type: "mrkdwn",
        },
      ],
      type: "context",
    });
  }

  blocks.push({
    block_id: `pipeline_actions:${input.sessionId}:${input.version}`,
    elements: [
      {
        action_id: "pipeline_approve",
        style: "primary",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          session_id: input.sessionId,
          version: input.version,
        }),
      },
      {
        action_id: "pipeline_request_changes",
        text: { text: "Request Changes", type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          session_id: input.sessionId,
          version: input.version,
        }),
      },
    ],
    type: "actions",
  });

  return blocks;
}

export function formatGenerationFailureBlocks(stageName: string): Record<string, unknown>[] {
  return [
    {
      text: {
        text: `:warning: ${escapeMrkdwn(stageName)} stage failed to generate. An operator will investigate.`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

export function formatEscalationDmBlocks(input: {
  channelId: string;
  linearUrl: string | null;
  rejectionCount: number;
  sessionTitle: string;
  stageName: string;
  threadTs: string;
}): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: `:rotating_light: *Stage escalation: ${escapeMrkdwn(input.sessionTitle)}*\n\nThe *${escapeMrkdwn(input.stageName)}* stage has been rejected ${input.rejectionCount} times. The reviewer may need your help resolving the feedback.`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      elements: [
        {
          text: `<https://slack.com/archives/${input.channelId}/p${input.threadTs.replace(".", "")}|View Slack thread>${input.linearUrl ? ` | <${input.linearUrl}|View in Linear>` : ""}`,
          type: "mrkdwn",
        },
      ],
      type: "context",
    },
  ];

  return blocks;
}

// Slack Web API responds 200 OK with `{ ok: false, error: "..." }` for most
// logical failures (invalid_auth, missing_scope, channel_not_found,
// thread_not_found, invalid_blocks). These helpers throw on `ok: false` so an
// outer try/catch is the only way to continue past a Slack failure — which
// makes the failure path explicit at every call site.
async function callSlackApi<T extends { ok: boolean; error?: string }>(
  url: string,
  body: Record<string, unknown>,
  botToken: string,
): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Slack API ${url} returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as T;
  if (!data.ok) {
    throw new Error(`Slack API ${url} returned ok:false (${data.error ?? "unknown"})`);
  }
  return data;
}

export async function postSlackMessage(input: {
  blocks: Record<string, unknown>[];
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<{ ts: string }> {
  const body: Record<string, unknown> = {
    blocks: input.blocks,
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) {
    body.thread_ts = input.threadTs;
  }

  const data = await callSlackApi<{ ok: boolean; error?: string; ts?: string }>(
    "https://slack.com/api/chat.postMessage",
    body,
    input.botToken,
  );
  return { ts: data.ts ?? "" };
}

export async function updateSlackMessage(input: {
  blocks: Record<string, unknown>[];
  botToken: string;
  channel: string;
  text: string;
  ts: string;
}): Promise<void> {
  await callSlackApi<{ ok: boolean; error?: string }>(
    "https://slack.com/api/chat.update",
    {
      blocks: input.blocks,
      channel: input.channel,
      text: input.text,
      ts: input.ts,
    },
    input.botToken,
  );
}

export async function openSlackDm(input: { botToken: string; userId: string }): Promise<string> {
  const data = await callSlackApi<{
    channel?: { id?: string };
    error?: string;
    ok: boolean;
  }>("https://slack.com/api/conversations.open", { users: input.userId }, input.botToken);

  const channelId = data.channel?.id;
  if (!channelId) {
    throw new Error("Slack conversations.open returned ok:true but no channel.id");
  }
  return channelId;
}

export async function openSlackView(input: {
  botToken: string;
  triggerId: string;
  view: Record<string, unknown>;
}): Promise<void> {
  await callSlackApi<{ ok: boolean; error?: string }>(
    "https://slack.com/api/views.open",
    { trigger_id: input.triggerId, view: input.view },
    input.botToken,
  );
}
