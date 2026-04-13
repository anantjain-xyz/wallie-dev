import { describe, expect, it } from "vitest";

import { SESSION_PHASE_ORDER } from "@/features/sessions/types";

import { DEFAULT_PROMPT_TEMPLATES } from "./defaults";

describe("DEFAULT_PROMPT_TEMPLATES", () => {
  it("has a template for every session phase", () => {
    for (const phase of SESSION_PHASE_ORDER) {
      expect(DEFAULT_PROMPT_TEMPLATES[phase]).toBeDefined();
      expect(typeof DEFAULT_PROMPT_TEMPLATES[phase]).toBe("string");
      expect(DEFAULT_PROMPT_TEMPLATES[phase].length).toBeGreaterThan(0);
    }
  });

  it("engineering template contains key variables", () => {
    const template = DEFAULT_PROMPT_TEMPLATES.engineering;
    expect(template).toContain("{{session.title}}");
    expect(template).toContain("{{session.prompt}}");
    expect(template).toContain("{{repo.fullName}}");
    expect(template).toContain("{{#if artifact.productSpec}}");
    expect(template).toContain("{{#if attempt.feedback}}");
  });

  it("design template contains key variables", () => {
    const template = DEFAULT_PROMPT_TEMPLATES.design;
    expect(template).toContain("{{session.title}}");
    expect(template).toContain("{{#if artifact.productSpec}}");
  });
});
