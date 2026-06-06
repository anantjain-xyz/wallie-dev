import { describe, expect, it } from "vitest";

import { renderStagePrompt } from "./index";

const stage = {
  promptTemplateMd:
    "Implement: {{session.title}}\n{{#if attempt.feedback}}Feedback: {{attempt.feedback}}{{/if}}",
  slug: "build",
};

const baseInput = {
  attemptFeedback: null,
  attemptNumber: 1,
  sessionPrompt: "Do the thing",
  sessionTitle: "My session",
};

describe("renderStagePrompt", () => {
  it("renders the stage template and resolves variables", () => {
    const result = renderStagePrompt(stage, baseInput);
    expect(result).toContain("Implement: My session");
  });

  it("prepends operating rules above the stage prompt", () => {
    const result = renderStagePrompt(stage, {
      ...baseInput,
      operatingRulesMd: "## Operating rules\n- Be autonomous.",
    });
    expect(result.startsWith("## Operating rules\n- Be autonomous.")).toBe(true);
    expect(result.indexOf("## Operating rules")).toBeLessThan(result.indexOf("Implement:"));
  });

  it("renders template variables inside operating rules too", () => {
    const result = renderStagePrompt(stage, {
      ...baseInput,
      operatingRulesMd: "Session: {{session.title}}",
    });
    expect(result).toContain("Session: My session");
  });

  it("omits the preamble when operating rules are empty or whitespace", () => {
    expect(renderStagePrompt(stage, { ...baseInput, operatingRulesMd: "" })).toBe(
      renderStagePrompt(stage, baseInput),
    );
    expect(renderStagePrompt(stage, { ...baseInput, operatingRulesMd: "   \n  " })).toBe(
      renderStagePrompt(stage, baseInput),
    );
  });
});
