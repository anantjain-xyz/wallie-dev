import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";

import { renderStagePrompt } from "./index";

const classifiedStage = {
  promptTemplateMd: trustedPromptValue("stage.promptTemplate", "{{session.title}}"),
  slug: trustedPromptValue("stage.slug", "build"),
};

const classifiedInput = {
  attemptFeedback: untrustedPromptValue("attempt.feedback", "Please add tests"),
  attemptNumber: 2,
  operatingRulesMd: trustedPromptValue("pipeline.operatingRules", "Keep changes scoped."),
  previousStages: {
    plan: untrustedPromptValue("artifact.previousStages.plan", "Approved plan"),
  },
  sessionPullRequest: untrustedPromptValue(
    "session.pullRequest",
    "Pull request #42: https://github.com/acme/app/pull/42",
  ),
  sessionPrompt: untrustedPromptValue("session.prompt", "Implement the approved plan"),
  sessionTitle: untrustedPromptValue("session.title", "Typed prompt boundaries"),
};

// Positive fixture: every string has an explicit trust classification.
renderStagePrompt(classifiedStage, classifiedInput);

renderStagePrompt(classifiedStage, {
  ...classifiedInput,
  // Deliberately failing fixture: the renderer must reject raw unclassified data.
  // @ts-expect-error raw strings cannot cross the typed prompt boundary
  sessionTitle: "raw session title",
});

renderStagePrompt(
  {
    ...classifiedStage,
    // Deliberately failing fixture: workspace control text must also be classified.
    // @ts-expect-error raw templates cannot bypass trusted classification
    promptTemplateMd: "{{session.title}}",
  },
  classifiedInput,
);
