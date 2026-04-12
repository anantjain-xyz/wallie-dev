import "server-only";

import type { ProductSpec } from "./types";

// Slack mrkdwn escape: `<url|label>` is rendered as a clickable link and
// `<!channel>` etc are control sequences. LLM-generated spec fields flow
// into mrkdwn sections, so any unescaped `<` allows a Linear ticket author
// to plant phishing links in the reviewer channel even if the LLM ignores
// the injection attempt and simply quotes the hostile string verbatim.
// Slack's documented escape rule: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
// Order matters — escape `&` first so we don't double-escape.
export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSpecBlocks(input: {
  linearUrl: string | null;
  sessionId: string;
  spec: ProductSpec;
  version: number;
}): Record<string, unknown>[] {
  const esc = escapeMrkdwn;
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        // Slack `header` blocks require plain_text. The title is already the
        // header's bold style; no mrkdwn wrapping.
        emoji: true,
        text: `${input.spec.title} (v${input.version})`,
        type: "plain_text",
      },
      type: "header",
    },
    {
      text: {
        text: `*Problem Statement*\n${esc(input.spec.problem_statement)}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*User Story*\n${esc(input.spec.user_story)}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*Acceptance Criteria*\n${input.spec.acceptance_criteria.map((c) => `- ${esc(c)}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];

  if (input.spec.constraints.length > 0) {
    blocks.push({
      text: {
        text: `*Constraints*\n${input.spec.constraints.map((c) => `- ${esc(c)}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

  if (input.spec.non_goals.length > 0) {
    blocks.push({
      text: {
        text: `*Non-Goals*\n${input.spec.non_goals.map((n) => `- ${esc(n)}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

  if (input.spec.open_questions.length > 0) {
    blocks.push({
      text: {
        text: `*Open Questions*\n${input.spec.open_questions.map((q) => `- ${esc(q)}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

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

  // Action buttons
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

export function formatPreScreenFailBlocks(reason: string): Record<string, unknown>[] {
  return [
    {
      text: {
        text: `:warning: This issue needs more detail before I can generate a spec.\n\n*Reason:* ${escapeMrkdwn(reason)}`,
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
  specTitle: string;
  threadTs: string;
}): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: `:rotating_light: *Spec escalation: ${escapeMrkdwn(input.specTitle)}*\n\nThis spec has been rejected ${input.rejectionCount} times. The reviewer may need your help resolving the feedback.`,
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

export function formatSpecDiffBlocks(input: {
  newSpec: ProductSpec;
  oldSpec: ProductSpec;
}): Record<string, unknown>[] {
  const changes: string[] = [];

  if (input.oldSpec.problem_statement !== input.newSpec.problem_statement) {
    changes.push("- Problem statement updated");
  }
  if (input.oldSpec.user_story !== input.newSpec.user_story) {
    changes.push("- User story updated");
  }

  const oldCriteria = new Set(input.oldSpec.acceptance_criteria);
  const newCriteria = new Set(input.newSpec.acceptance_criteria);
  const addedCriteria = input.newSpec.acceptance_criteria.filter((c) => !oldCriteria.has(c));
  const removedCriteria = input.oldSpec.acceptance_criteria.filter((c) => !newCriteria.has(c));
  if (addedCriteria.length > 0) changes.push(`- Added ${addedCriteria.length} acceptance criteria`);
  if (removedCriteria.length > 0)
    changes.push(`- Removed ${removedCriteria.length} acceptance criteria`);

  const oldConstraints = new Set(input.oldSpec.constraints);
  const newConstraints = new Set(input.newSpec.constraints);
  const addedConstraints = input.newSpec.constraints.filter((c) => !oldConstraints.has(c));
  const removedConstraints = input.oldSpec.constraints.filter((c) => !newConstraints.has(c));
  if (addedConstraints.length > 0) changes.push(`- Added ${addedConstraints.length} constraints`);
  if (removedConstraints.length > 0)
    changes.push(`- Removed ${removedConstraints.length} constraints`);

  if (changes.length === 0) {
    changes.push("- Minor wording changes");
  }

  return [
    {
      text: {
        text: `*Changes from previous version:*\n${changes.join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

// Slack Web API responds 200 OK with `{ ok: false, error: "..." }` for most
// logical failures (invalid_auth, missing_scope, channel_not_found,
// thread_not_found, invalid_blocks). Earlier versions of these helpers
// returned the raw body and every caller forgot to check `ok`, so a failed
// post would silently advance pipeline state. These helpers now throw on
// `ok: false` so an outer try/catch is the only way to continue past a
// Slack failure — which makes the failure path explicit at every call site.
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
