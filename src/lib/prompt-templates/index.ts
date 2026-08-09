import {
  verifyPromptBoundary,
  type TrustedPromptValue,
  type UntrustedPromptValue,
} from "@/lib/pipeline/prompt-safety";

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
  sessionTitle: UntrustedPromptValue;
  sessionPrompt: UntrustedPromptValue;
  stageSlug: TrustedPromptValue;
  attemptNumber: number;
  attemptFeedback: UntrustedPromptValue | null;
  repoName?: UntrustedPromptValue;
  repoFullName?: UntrustedPromptValue;
  repoDefaultBranch?: UntrustedPromptValue;
  previousStages?: Record<string, UntrustedPromptValue>;
}): TemplateVariables {
  return {
    session: {
      title: verifyPromptBoundary(input.sessionTitle),
      prompt: verifyPromptBoundary(input.sessionPrompt),
      stageSlug: verifyPromptBoundary(input.stageSlug),
    },
    attempt: {
      number: input.attemptNumber,
      feedback: input.attemptFeedback ? verifyPromptBoundary(input.attemptFeedback) : "",
    },
    repo: {
      name: input.repoName ? verifyPromptBoundary(input.repoName) : "",
      fullName: input.repoFullName ? verifyPromptBoundary(input.repoFullName) : "",
      defaultBranch: input.repoDefaultBranch
        ? verifyPromptBoundary(input.repoDefaultBranch)
        : "main",
    },
    artifact: {
      previousStages: Object.fromEntries(
        Object.entries(input.previousStages ?? {}).map(([slug, value]) => [
          slug,
          verifyPromptBoundary(value),
        ]),
      ),
    },
  };
}

export function renderStagePrompt(
  stage: {
    promptTemplateMd: TrustedPromptValue;
    slug: TrustedPromptValue;
  },
  input: {
    sessionTitle: UntrustedPromptValue;
    sessionPrompt: UntrustedPromptValue;
    attemptNumber: number;
    attemptFeedback: UntrustedPromptValue | null;
    repoName?: UntrustedPromptValue;
    repoFullName?: UntrustedPromptValue;
    repoDefaultBranch?: UntrustedPromptValue;
    previousStages?: Record<string, UntrustedPromptValue>;
    sessionPullRequest?: UntrustedPromptValue;
    sessionAttachments?: UntrustedPromptValue;
    sessionAttachmentInstructions?: TrustedPromptValue;
    // Workspace-editable operating rules (pipelines.operating_rules_md),
    // prepended to every stage prompt. Empty/whitespace-only → no preamble.
    operatingRulesMd?: TrustedPromptValue;
  },
): string {
  const variables = buildStageTemplateVariables({ ...input, stageSlug: stage.slug });
  const operatingRulesValue = input.operatingRulesMd
    ? verifyPromptBoundary(input.operatingRulesMd)
    : "";
  const operatingRules = operatingRulesValue.trim();
  const stageTemplate = verifyPromptBoundary(stage.promptTemplateMd);
  const source = operatingRules ? `${operatingRules}\n\n${stageTemplate}` : stageTemplate;
  const renderedStage = renderTemplate(source, variables);
  const pullRequestData = input.sessionPullRequest
    ? verifyPromptBoundary(input.sessionPullRequest)
    : "";
  const attachmentData = input.sessionAttachments
    ? verifyPromptBoundary(input.sessionAttachments)
    : "";
  const attachmentInstructions = input.sessionAttachmentInstructions
    ? verifyPromptBoundary(input.sessionAttachmentInstructions).trim()
    : "";

  const sections = [renderedStage];
  if (pullRequestData) {
    sections.push(
      "## Wallie pull request\nUse this Wallie-recorded pull request for review, checks, and landing:\n" +
        pullRequestData,
    );
  }
  if (attachmentData && attachmentInstructions) {
    sections.push(`${attachmentInstructions}\n${attachmentData}`);
  }
  return sections.join("\n\n");
}
