import { describe, expect, it } from "vitest";

import { inspectFactoryPromptReferences } from "./prompt-references";

const stages = [
  { id: "stage-brief", slug: "project-brief" },
  { id: "stage-review", slug: "design-review" },
  { id: "stage-release", slug: "release-prep" },
];

describe("factory prompt references", () => {
  it("resolves conditional headers and direct placeholders in first source order", () => {
    const template = [
      "{{#if artifact.previousStages.design-review}}A review exists.{{/if}}",
      "{{artifact.previousStages.project-brief}}",
      "{{artifact.previousStages.design-review}}",
    ].join("\n");

    expect(inspectFactoryPromptReferences(template, stages, 2)).toEqual({
      stageIds: ["stage-review", "stage-brief"],
      errors: [],
    });
  });

  it("rejects unknown, current, and future stages in a stage template", () => {
    const template = [
      "{{artifact.previousStages.missing-stage}}",
      "{{artifact.previousStages.design-review}}",
      "{{artifact.previousStages.release-prep}}",
      "{{artifact.previousStages.missing-stage}}",
    ].join("\n");

    const result = inspectFactoryPromptReferences(template, stages, 1);

    expect(result.stageIds).toEqual([]);
    expect(result.errors).toMatchObject([
      { slug: "missing-stage", code: "missing_reference" },
      { slug: "design-review", code: "unreachable_stage" },
      { slug: "release-prep", code: "unreachable_stage" },
    ]);
  });

  it("allows shared rules to refer to any stage and matches the renderer's token syntax", () => {
    const template = [
      "{{#if\tartifact.previousStages.release-prep}}\nReady.\n{{/if}}",
      "{{ artifact.previousStages.spaced-token }}",
      "{{attempt.feedback}}",
      "{{#if artifact.previousStages.unclosed}}",
    ].join("\n");

    expect(inspectFactoryPromptReferences(template, stages)).toEqual({
      stageIds: ["stage-release"],
      errors: [],
    });
  });
});
