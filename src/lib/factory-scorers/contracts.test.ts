import { describe, expect, it } from "vitest";

import { factoryScorerDefinitionSchema } from "./contracts";
import { factoryScorerResultSchema, resolveFactoryScorerResult } from "./result";

const diff = { kind: "code_diff", id: "00000000-0000-4000-8000-000000000001" } as const;
const artifact = { kind: "artifact", id: "00000000-0000-4000-8000-000000000002" } as const;

const rubric = {
  schemaVersion: 1,
  rubric: "  確認 each change against the reported evidence.\n",
  requiredEvidence: ["code_diff", "artifact"],
};
const booleanScoring = { kind: "boolean", passValue: false };
const numericScoring = {
  kind: "numeric",
  min: 0,
  max: 5,
  direction: "higher_is_better",
  passThreshold: 4,
  failThreshold: 2,
};

function booleanDefinition() {
  return factoryScorerDefinitionSchema.parse({ ...rubric, scoring: booleanScoring });
}

describe("factory scorer revisions", () => {
  it("preserves rubric text and evidence order while freezing the validated revision", () => {
    const raw = { ...rubric, scoring: booleanScoring };
    const frozen = factoryScorerDefinitionSchema.parse(raw);
    const later = factoryScorerDefinitionSchema.parse({
      ...raw,
      rubric: "Use the second rubric.",
      requiredEvidence: ["artifact", "code_diff"],
      scoring: { kind: "boolean", passValue: true },
    });
    expect(frozen).toEqual(raw);
    expect(frozen).not.toEqual(later);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.requiredEvidence)).toBe(true);
    expect(Object.isFrozen(frozen.scoring)).toBe(true);
  });

  it.each([
    { schemaVersion: 2 },
    { rubric: "\n\t\u00a0" },
    { rubric: "\0not valid" },
    { rubric: "\ud800" },
    { rubric: "𠮷".repeat(20_001) },
    { requiredEvidence: [] },
    { requiredEvidence: ["code_diff", "code_diff"] },
    { requiredEvidence: ["unknown"] },
    { extra: null },
    { scoring: { ...booleanScoring, passValue: "false" } },
    { scoring: { ...numericScoring, min: 5 } },
    { scoring: { ...numericScoring, max: Infinity } },
    { scoring: { ...numericScoring, max: 1_000_000_001 } },
    { scoring: { ...numericScoring, passThreshold: 6 } },
    { scoring: { ...numericScoring, passThreshold: 2 } },
    { scoring: { ...numericScoring, failThreshold: -1 } },
    { scoring: { ...numericScoring, direction: "lower_is_better" } },
  ])("rejects malformed definitions and conflicting thresholds %#", (override) => {
    expect(
      factoryScorerDefinitionSchema.safeParse({ ...rubric, scoring: numericScoring, ...override })
        .success,
    ).toBe(false);
  });

  it("counts Unicode code points and accepts thresholds on range endpoints", () => {
    const scoring = { ...numericScoring, passThreshold: 5, failThreshold: 0 };
    const raw = { ...rubric, rubric: "𠮷".repeat(20_000), scoring };
    expect(factoryScorerDefinitionSchema.parse(raw)).toEqual(raw);
  });
});

describe("factory scorer outcomes", () => {
  it.each([
    ["higher_is_better", 0, "fail"],
    ["higher_is_better", 2, "fail"],
    ["higher_is_better", 2.5, "inconclusive"],
    ["higher_is_better", 4, "pass"],
    ["higher_is_better", 5, "pass"],
    ["lower_is_better", 0, "pass"],
    ["lower_is_better", 2, "pass"],
    ["lower_is_better", 3.5, "inconclusive"],
    ["lower_is_better", 4, "fail"],
    ["lower_is_better", 5, "fail"],
  ])("uses inclusive %s thresholds for score %d", (direction, value, status) => {
    const thresholds =
      direction === "higher_is_better"
        ? { passThreshold: 4, failThreshold: 2 }
        : { passThreshold: 2, failThreshold: 4 };
    const definition = factoryScorerDefinitionSchema.parse({
      ...rubric,
      scoring: { ...numericScoring, direction, ...thresholds },
    });
    const outcome = resolveFactoryScorerResult({
      definition,
      evidence: [diff, artifact],
      outcome: { kind: "scored", value },
    });

    expect(outcome).toEqual({
      schemaVersion: 1,
      evidence: [diff, artifact],
      status,
      score: { kind: "numeric", value },
      ...(status === "inconclusive" ? { reason: "between_thresholds" } : {}),
    });
  });

  it.each([
    [false, "pass"],
    [true, "fail"],
  ])("uses the configured boolean pass value for %s", (value, status) => {
    const outcome = resolveFactoryScorerResult({
      definition: booleanDefinition(),
      evidence: [diff, artifact],
      outcome: { kind: "scored", value },
    });
    expect(outcome).toMatchObject({ status, score: { kind: "boolean", value } });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.evidence)).toBe(true);
    expect(Object.isFrozen(outcome.evidence[0])).toBe(true);
  });

  it.each(["0", true, null, NaN, Infinity, -0.0001, 5.0001])(
    "rejects malformed or out-of-range judge scores %#",
    (value) => {
      const definition = factoryScorerDefinitionSchema.parse({
        ...rubric,
        scoring: numericScoring,
      });
      expect(
        resolveFactoryScorerResult({
          definition,
          evidence: [diff, artifact],
          outcome: { kind: "scored", value },
        }),
      ).toEqual({
        schemaVersion: 1,
        evidence: [diff, artifact],
        status: "error",
        reason: "invalid_output",
      });
    },
  );

  it("records unavailable required evidence without deriving a passing score", () => {
    expect(
      resolveFactoryScorerResult({
        definition: booleanDefinition(),
        evidence: [diff],
        outcome: { kind: "scored", value: false },
      }),
    ).toEqual({
      schemaVersion: 1,
      evidence: [diff],
      status: "inconclusive",
      reason: "missing_evidence",
      missingEvidence: ["artifact"],
    });
  });

  it("preserves an explicit exclusion even with no available evidence", () => {
    expect(
      resolveFactoryScorerResult({
        definition: booleanDefinition(),
        evidence: [],
        outcome: { kind: "skipped", reason: "not_sampled" },
      }),
    ).toEqual({ schemaVersion: 1, evidence: [], status: "skipped", reason: "not_sampled" });
  });

  it("keeps evidence ambiguity and provider failure distinct from scored results", () => {
    const scope = { definition: booleanDefinition(), evidence: [diff, artifact] };
    expect(
      resolveFactoryScorerResult({
        ...scope,
        outcome: { kind: "inconclusive", reason: "ambiguous_evidence" },
      }),
    ).toMatchObject({ status: "inconclusive", reason: "ambiguous_evidence" });
    expect(
      resolveFactoryScorerResult({ ...scope, outcome: { kind: "error", reason: "timeout" } }),
    ).toMatchObject({ status: "error", reason: "timeout" });
  });

  it.each([
    { status: "pass" },
    { status: "pass", score: { kind: "boolean", value: false }, evidence: [] },
    { status: "fail", score: { kind: "numeric", value: NaN } },
    {
      status: "inconclusive",
      reason: "between_thresholds",
      score: { kind: "boolean", value: false },
    },
    { status: "inconclusive", reason: "missing_evidence", missingEvidence: ["code_diff"] },
    { status: "skipped", reason: "not_sampled", score: { kind: "numeric", value: 0 } },
    { status: "error", reason: "invalid_output", score: { kind: "numeric", value: 0 } },
    { status: "skipped", reason: "not_sampled", evidence: [diff, diff] },
    {
      status: "skipped",
      reason: "not_sampled",
      evidence: [{ kind: "code_diff", id: "main" }],
    },
  ])("rejects contradictory result payloads %#", (payload) => {
    expect(
      factoryScorerResultSchema.safeParse({ schemaVersion: 1, evidence: [diff], ...payload })
        .success,
    ).toBe(false);
  });
});
