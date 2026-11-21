import { describe, expect, it } from "vitest";

import {
  modelRoutingConfigurationSchema,
  modelRoutingPolicySchema,
  modelRoutingTargets,
  routingFailureAfterPromotion,
} from "./contracts";

const repairClass = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  slug: "bug-repair",
  name: "Bug repair",
};
const documentationClass = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  slug: "documentation",
  name: "Documentation",
};
const configuration = {
  agentId: "aaaaaaaa-0000-4000-8000-000000000003",
  definitionRevisionId: "aaaaaaaa-0000-4000-8000-000000000004",
  experimentId: "aaaaaaaa-0000-4000-8000-000000000005",
  qualificationId: "aaaaaaaa-0000-4000-8000-000000000006",
  modelKey: "openai/gpt-5.6-sol-2026-11-01",
  harness: "codex",
  workerRuntime: "workerd",
};
const constraints = {
  qualityFloorBps: 8_000,
  maxMeanCostUsd: 0.01,
  maxLatencyMs: 20_000,
  minResolvedTrials: 12,
  minConfidenceBps: null,
};
const repairRule = {
  id: "aaaaaaaa-0000-4000-8000-000000000007",
  taskClassId: repairClass.id,
  configuration,
  constraints,
  onUnavailable: { kind: "escalate" },
};
const documentationRule = {
  ...repairRule,
  id: "aaaaaaaa-0000-4000-8000-000000000008",
  taskClassId: documentationClass.id,
};
const policy = {
  version: 1,
  taskClasses: [repairClass, documentationClass],
  rules: [documentationRule, repairRule],
  onUnmatched: { kind: "escalate" },
};

describe("model routing policy contract", () => {
  it("preserves rule order and stable identifiers through a JSON round trip", () => {
    const compiled = modelRoutingPolicySchema.parse({
      ...policy,
      taskClasses: [
        { ...repairClass, id: repairClass.id.toUpperCase(), name: "  Fix defects  " },
        documentationClass,
      ],
    });

    expect(modelRoutingPolicySchema.parse(JSON.parse(JSON.stringify(compiled)))).toEqual(compiled);
    expect(compiled.taskClasses[0]).toEqual({ ...repairClass, name: "Fix defects" });
    expect(compiled.rules.map(({ id }) => id)).toEqual([documentationRule.id, repairRule.id]);
  });

  it("rejects duplicate IDs and slugs and multiple rules for one class", () => {
    const result = modelRoutingPolicySchema.safeParse({
      ...policy,
      taskClasses: [repairClass, { ...repairClass, id: repairClass.id.toUpperCase() }],
      rules: [repairRule, { ...repairRule, id: repairRule.id.toUpperCase() }],
    });

    expect(result.error?.issues.map(({ path }) => path)).toEqual([
      ["taskClasses", 1, "id"],
      ["taskClasses", 1, "slug"],
      ["rules", 1, "id"],
      ["rules", 1, "taskClassId"],
    ]);
  });

  it("rejects a rule whose task class does not exist in the taxonomy", () => {
    const result = modelRoutingPolicySchema.safeParse({ ...policy, taskClasses: [repairClass] });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["rules", 0, "taskClassId"] }),
    ]);
  });

  it.each([
    ["qualityFloorBps", 10_001],
    ["maxMeanCostUsd", -0.01],
    ["maxLatencyMs", 0],
    ["minResolvedTrials", 1],
    ["minConfidenceBps", 0.5],
    ["maxMeanCostUsd", undefined],
  ])("rejects invalid or unspecified constraints at %s", (key, value) => {
    const result = modelRoutingPolicySchema.safeParse({
      ...policy,
      rules: [{ ...repairRule, constraints: { ...constraints, [key]: value } }],
    });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["rules", 0, "constraints", key] }),
    ]);
  });

  it("preserves explicit nulls for unused constraints and requires unavailable behavior", () => {
    const withoutOptionalCeilings = {
      ...repairRule,
      constraints: { ...constraints, maxMeanCostUsd: null, maxLatencyMs: null },
    };
    const compiled = modelRoutingPolicySchema.parse({
      ...policy,
      rules: [withoutOptionalCeilings],
    });

    expect(compiled.rules).toEqual([withoutOptionalCeilings]);
    expect(modelRoutingPolicySchema.safeParse({ ...policy, onUnmatched: undefined }).success).toBe(
      false,
    );
    expect(
      modelRoutingPolicySchema.safeParse({
        ...policy,
        rules: [{ ...withoutOptionalCeilings, onUnavailable: undefined }],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["modelKey", "Friendly Model Name"],
    ["harness", "undefined-harness"],
    ["workerRuntime", "browser"],
    ["qualificationId", "recent probe"],
  ])("rejects an unsupported configuration at %s", (key, value) => {
    const result = modelRoutingPolicySchema.safeParse({
      ...policy,
      rules: [{ ...repairRule, configuration: { ...configuration, [key]: value } }],
    });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["rules", 0, "configuration", key] }),
    ]);
  });

  it("rejects falling back to the same execution configuration under a different receipt", () => {
    const result = modelRoutingPolicySchema.safeParse({
      ...policy,
      rules: [
        {
          ...repairRule,
          onUnavailable: {
            kind: "fallback",
            configuration: {
              ...configuration,
              experimentId: "aaaaaaaa-0000-4000-8000-000000000009",
              qualificationId: "aaaaaaaa-0000-4000-8000-000000000010",
            },
          },
        },
      ],
    });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["rules", 0, "onUnavailable", "configuration"] }),
    ]);
  });

  it("escalates after promotion to the previous fallback even when the evidence IDs differ", () => {
    const oldPolicy = modelRoutingPolicySchema.parse({
      ...policy,
      rules: [
        {
          ...repairRule,
          onUnavailable: {
            kind: "fallback",
            configuration: {
              ...configuration,
              workerRuntime: "node",
              scorerRevisionId: "aaaaaaaa-0000-4000-8000-000000000009",
            },
          },
        },
      ],
    });
    const [prior] = oldPolicy.rules;
    const promoted = modelRoutingConfigurationSchema.parse({
      ...configuration,
      workerRuntime: "node",
      experimentId: "aaaaaaaa-0000-4000-8000-000000000010",
      qualificationId: "aaaaaaaa-0000-4000-8000-000000000011",
      scorerRevisionId: "aaaaaaaa-0000-4000-8000-000000000012",
    });

    const updated = modelRoutingPolicySchema.parse({
      ...oldPolicy,
      rules: [
        {
          ...prior,
          configuration: promoted,
          onUnavailable: routingFailureAfterPromotion({
            configuration: promoted,
            previous: prior.onUnavailable,
          }),
        },
      ],
    });

    expect(updated.rules).toEqual([
      { ...prior, configuration: promoted, onUnavailable: { kind: "escalate" } },
    ]);
    expect(
      routingFailureAfterPromotion({
        configuration: prior.configuration,
        previous: prior.onUnavailable,
      }),
    ).toEqual(prior.onUnavailable);
  });

  it("supplies reference validation paths for primary, unavailable, and unmatched choices", () => {
    const fallback = {
      kind: "fallback",
      configuration: { ...configuration, workerRuntime: "node" },
    };
    const compiled = modelRoutingPolicySchema.parse({
      ...policy,
      rules: [{ ...repairRule, onUnavailable: fallback }],
      onUnmatched: { ...fallback, constraints },
    });

    expect(modelRoutingTargets(compiled)).toEqual([
      { configuration, path: ["rules", 0, "configuration"] },
      {
        configuration: fallback.configuration,
        path: ["rules", 0, "onUnavailable", "configuration"],
      },
      { configuration: fallback.configuration, path: ["onUnmatched", "configuration"] },
    ]);
  });
});
