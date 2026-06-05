import type { PipelineStage } from "@/features/sessions/types";

import { renderTemplate, type TemplateVariables } from "./render";

export { renderTemplate, type TemplateVariables } from "./render";

/**
 * Template variables available inside a stage's prompt_template_md.
 *
 *   {{session.title}}                       — Session title
 *   {{session.prompt}}                      — Original user prompt / description
 *   {{session.stageSlug}}                   — Slug of the stage currently running
 *   {{attempt.number}}                      — Attempt number (1-based)
 *   {{attempt.feedback}}                    — Feedback from prior rejection (empty on first attempt)
 *   {{repo.name}}, {{repo.fullName}},
 *   {{repo.defaultBranch}}                  — Repo context (empty if no repo connected)
 *   {{artifact.previousStages.<slug>}}      — Markdown of the latest approved
 *                                             artifact for any earlier stage
 *
 * The pipeline's operating rules (pipelines.operating_rules_md) are prepended to
 * the stage template before rendering, so they can reference these variables too.
 */
export function buildStageTemplateVariables(input: {
  sessionTitle: string;
  sessionPrompt: string;
  stageSlug: string;
  attemptNumber: number;
  attemptFeedback: string | null;
  repoName?: string;
  repoFullName?: string;
  repoDefaultBranch?: string;
  previousStages?: Record<string, string>;
}): TemplateVariables {
  return {
    session: {
      title: input.sessionTitle,
      prompt: input.sessionPrompt,
      stageSlug: input.stageSlug,
    },
    attempt: {
      number: input.attemptNumber,
      feedback: input.attemptFeedback ?? "",
    },
    repo: {
      name: input.repoName ?? "",
      fullName: input.repoFullName ?? "",
      defaultBranch: input.repoDefaultBranch ?? "main",
    },
    artifact: {
      previousStages: input.previousStages ?? {},
    },
  };
}

export function renderStagePrompt(
  stage: Pick<PipelineStage, "promptTemplateMd" | "slug">,
  input: {
    sessionTitle: string;
    sessionPrompt: string;
    attemptNumber: number;
    attemptFeedback: string | null;
    repoName?: string;
    repoFullName?: string;
    repoDefaultBranch?: string;
    previousStages?: Record<string, string>;
    // Workspace-editable operating rules (pipelines.operating_rules_md),
    // prepended to every stage prompt. Empty/whitespace-only → no preamble.
    operatingRulesMd?: string;
  },
): string {
  const variables = buildStageTemplateVariables({ ...input, stageSlug: stage.slug });
  const operatingRules = input.operatingRulesMd?.trim() ? input.operatingRulesMd.trim() : "";
  const source = operatingRules
    ? `${operatingRules}\n\n${stage.promptTemplateMd}`
    : stage.promptTemplateMd;
  return renderTemplate(source, variables);
}
