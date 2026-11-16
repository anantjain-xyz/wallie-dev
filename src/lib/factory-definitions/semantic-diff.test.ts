import { describe, expect, it } from "vitest";

import type { CompiledFactoryDefinition } from "./compiler";
import { compareFactoryDefinitions } from "./semantic-diff";

type Stage = CompiledFactoryDefinition["stages"][number];

const plan: Stage = {
  id: "3f1bbc80-e239-45b6-b3fc-8f338a7837fe",
  name: "Plan",
  slug: "plan",
  description: "",
  promptTemplateMd: "Plan the change.",
  anyoneCanApprove: false,
  approverMemberIds: [],
  previousStageIds: [],
};

const build: Stage = {
  ...plan,
  id: "34328636-48ae-4a9e-ab9e-9d371ee1b86d",
  name: "Build",
  slug: "build",
  promptTemplateMd: "Build the change.",
};

const review: Stage = {
  ...plan,
  id: "567d84d0-35ec-4f36-a999-0bfa0752c530",
  name: "Review",
  slug: "review",
  promptTemplateMd: "Review the change.",
};

const before: CompiledFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipelineId: "3a839833-2c05-4167-b831-f1f2f4e65bb7",
  repositoryId: "14b23dce-cf9a-4d0f-a2cd-2e1aa4a87823",
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 2,
    maxTurns: 100,
  },
  executionPolicyRevisionId: null,
  deliveryPolicyRevisionId: null,
  skillIds: ["skill-id"],
  toolIds: [],
  operatingRulesMd: "Follow the review checklist.",
  operatingRuleStageIds: [],
  stages: [plan, build],
};

describe("compareFactoryDefinitions", () => {
  it("treats identical compiled settings and independently allocated lists as equal", () => {
    expect(compareFactoryDefinitions(before, structuredClone(before))).toEqual({
      fields: [],
      stages: [],
    });
  });

  it("reports a stage inserted before existing stages as one addition", () => {
    const result = compareFactoryDefinitions(before, { ...before, stages: [review, plan, build] });
    expect(result.fields).toEqual([]);
    expect(result.stages).toMatchObject([{ kind: "added", id: review.id, position: 1 }]);
    expect(result.stages[0].fields.map(({ label }) => label)).not.toContain("Description");
  });

  it("reports stage reordering and edits by stable ID with exact values", () => {
    const result = compareFactoryDefinitions(before, {
      ...before,
      operatingRulesMd: "Run the verification checklist.",
      agent: { ...before.agent, concurrencyLimit: 2 },
      stages: [build, { ...plan, name: "Design", promptTemplateMd: "Draft a design." }],
    });

    expect(result.fields).toMatchObject([
      {
        label: "Operating rules",
        before: "Follow the review checklist.",
        after: "Run the verification checklist.",
      },
      { label: "Agent concurrency limit", before: 1, after: 2 },
    ]);
    expect(result.stages).toMatchObject([
      { kind: "changed", id: build.id, beforePosition: 2, afterPosition: 1, fields: [] },
      {
        kind: "changed",
        id: plan.id,
        beforePosition: 1,
        afterPosition: 2,
        fields: [
          { label: "Name", before: "Plan", after: "Design" },
          { label: "Prompt template", before: "Plan the change.", after: "Draft a design." },
        ],
      },
    ]);
  });

  it("reports removal and policy references without attributing movement to retained stages", () => {
    const result = compareFactoryDefinitions(before, {
      ...before,
      executionPolicyRevisionId: "9143f65f-c9b7-4a14-997a-4fb52d42879f",
      stages: [build],
    });
    expect(result.fields).toMatchObject([
      {
        label: "Execution policy revision",
        before: null,
        after: "9143f65f-c9b7-4a14-997a-4fb52d42879f",
      },
    ]);
    expect(result.stages).toMatchObject([{ kind: "removed", id: plan.id, position: 1 }]);
  });
});
