import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { ProductSpec } from "./types";

const SPEC_SYSTEM_PROMPT = `You are a senior product manager generating a structured product spec from a Linear issue.

Given the issue title and description, produce a complete product spec as JSON with this exact schema:

{
  "title": "Feature name",
  "problem_statement": "What problem does this solve and for whom?",
  "user_story": "As a [user], I want [goal] so that [benefit].",
  "acceptance_criteria": ["Criterion 1", "Criterion 2", ...],
  "constraints": ["Constraint 1", ...],
  "non_goals": ["What this feature does NOT do"],
  "open_questions": ["Unresolved question 1", ...]
}

Rules:
- acceptance_criteria must have at least 3 items
- Be specific and actionable, not vague
- Infer reasonable constraints from the context
- Flag genuine unknowns as open_questions
- Output ONLY valid JSON, no markdown wrapping`;

export async function generateProductSpec(input: {
  anthropicApiKey: string;
  feedback?: string | null;
  issueDescription: string;
  issueTitle: string;
  previousSpec?: ProductSpec | null;
}): Promise<ProductSpec> {
  const client = new Anthropic({ apiKey: input.anthropicApiKey });

  let userMessage = `Issue title: ${input.issueTitle}\n\nIssue description:\n${input.issueDescription || "(no description)"}`;

  if (input.previousSpec && input.feedback) {
    userMessage += `\n\n---\nPrevious spec (needs revision):\n${JSON.stringify(input.previousSpec, null, 2)}\n\nFeedback from reviewer:\n${input.feedback}`;
  }

  const response = await client.messages.create({
    max_tokens: 2000,
    messages: [{ content: userMessage, role: "user" }],
    model: "claude-sonnet-4-20250514",
    system: SPEC_SYSTEM_PROMPT,
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    const spec = JSON.parse(text) as ProductSpec;

    if (!spec.title || !spec.problem_statement || !Array.isArray(spec.acceptance_criteria)) {
      throw new Error("Spec missing required fields");
    }

    return {
      acceptance_criteria: spec.acceptance_criteria,
      constraints: spec.constraints ?? [],
      non_goals: spec.non_goals ?? [],
      open_questions: spec.open_questions ?? [],
      problem_statement: spec.problem_statement,
      title: spec.title,
      user_story: spec.user_story ?? "",
    };
  } catch {
    throw new Error(`Product agent returned invalid JSON: ${text.slice(0, 200)}`);
  }
}
