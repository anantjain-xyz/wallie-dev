import "server-only";

import type { ProductSpec } from "./types";

export function formatSpecBlocks(input: {
  linearUrl: string | null;
  pipelineIssueId: string;
  spec: ProductSpec;
  version: number;
}): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: `*${input.spec.title}* (v${input.version})`,
        type: "mrkdwn",
      },
      type: "header",
    },
    {
      text: {
        text: `*Problem Statement*\n${input.spec.problem_statement}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*User Story*\n${input.spec.user_story}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*Acceptance Criteria*\n${input.spec.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];

  if (input.spec.constraints.length > 0) {
    blocks.push({
      text: {
        text: `*Constraints*\n${input.spec.constraints.map((c) => `- ${c}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

  if (input.spec.non_goals.length > 0) {
    blocks.push({
      text: {
        text: `*Non-Goals*\n${input.spec.non_goals.map((n) => `- ${n}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

  if (input.spec.open_questions.length > 0) {
    blocks.push({
      text: {
        text: `*Open Questions*\n${input.spec.open_questions.map((q) => `- ${q}`).join("\n")}`,
        type: "mrkdwn",
      },
      type: "section",
    });
  }

  if (input.linearUrl) {
    blocks.push({
      text: {
        text: `<${input.linearUrl}|View in Linear>`,
        type: "mrkdwn",
      },
      type: "context",
    });
  }

  // Action buttons
  blocks.push({
    block_id: `pipeline_actions:${input.pipelineIssueId}:${input.version}`,
    elements: [
      {
        action_id: "pipeline_approve",
        style: "primary",
        text: { text: "Approve", type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          pipeline_issue_id: input.pipelineIssueId,
          version: input.version,
        }),
      },
      {
        action_id: "pipeline_request_changes",
        text: { text: "Request Changes", type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          pipeline_issue_id: input.pipelineIssueId,
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
        text: `:warning: This issue needs more detail before I can generate a spec.\n\n*Reason:* ${reason}`,
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
        text: `:rotating_light: *Spec escalation: ${input.specTitle}*\n\nThis spec has been rejected ${input.rejectionCount} times. The reviewer may need your help resolving the feedback.`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `<https://slack.com/archives/${input.channelId}/p${input.threadTs.replace(".", "")}|View Slack thread>${input.linearUrl ? ` | <${input.linearUrl}|View in Linear>` : ""}`,
        type: "mrkdwn",
      },
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

export async function postSlackMessage(input: {
  blocks: Record<string, unknown>[];
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<{ ok: boolean; ts?: string }> {
  const body: Record<string, unknown> = {
    blocks: input.blocks,
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) {
    body.thread_ts = input.threadTs;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  return (await response.json()) as { ok: boolean; ts?: string };
}

export async function updateSlackMessage(input: {
  blocks: Record<string, unknown>[];
  botToken: string;
  channel: string;
  text: string;
  ts: string;
}): Promise<{ ok: boolean }> {
  const response = await fetch("https://slack.com/api/chat.update", {
    body: JSON.stringify({
      blocks: input.blocks,
      channel: input.channel,
      text: input.text,
      ts: input.ts,
    }),
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  return (await response.json()) as { ok: boolean };
}

export async function openSlackDm(input: {
  botToken: string;
  userId: string;
}): Promise<string | null> {
  const response = await fetch("https://slack.com/api/conversations.open", {
    body: JSON.stringify({ users: input.userId }),
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const data = (await response.json()) as {
    channel?: { id?: string };
    ok: boolean;
  };
  return data.ok ? (data.channel?.id ?? null) : null;
}
