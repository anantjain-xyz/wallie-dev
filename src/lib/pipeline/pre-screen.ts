import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { PreScreenResult } from "./types";

const PRE_SCREEN_SYSTEM_PROMPT = `You are a product issue quality assessor. Your job is to determine if a Linear issue has enough context for a product agent to generate a useful spec.

Evaluate the issue title and description. An issue PASSES if it has:
- A clear problem statement or user need
- Enough context to understand what needs to be built
- At least a rough idea of scope

An issue FAILS if it has:
- Only a title with no description
- Vague requirements with no actionable detail
- Just a bug report with no reproduction steps or context

Respond with JSON: { "pass": true/false, "reason": "one sentence explanation" }`;

export async function preScreenIssue(input: {
  anthropicApiKey: string;
  issueDescription: string;
  issueTitle: string;
}): Promise<PreScreenResult> {
  const client = new Anthropic({ apiKey: input.anthropicApiKey });

  const response = await client.messages.create({
    max_tokens: 200,
    messages: [
      {
        content: `Issue title: ${input.issueTitle}\n\nIssue description:\n${input.issueDescription || "(no description)"}`,
        role: "user",
      },
    ],
    model: "claude-sonnet-4-20250514",
    system: PRE_SCREEN_SYSTEM_PROMPT,
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    const parsed = JSON.parse(text) as PreScreenResult;
    return {
      pass: Boolean(parsed.pass),
      reason: String(parsed.reason || "No reason provided"),
    };
  } catch {
    return { pass: false, reason: "Pre-screen returned invalid response" };
  }
}
