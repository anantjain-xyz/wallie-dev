import {
  factoryScorerDefinitionSchema,
  type FactoryScorerDefinition,
  type FactoryScorerEvidenceKind,
} from "./contracts";

function createPreset(
  name: string,
  slug: string,
  description: string,
  requiredEvidence: readonly FactoryScorerEvidenceKind[],
  rubric: string,
) {
  const definition: FactoryScorerDefinition = factoryScorerDefinitionSchema.parse({
    schemaVersion: 1,
    rubric,
    requiredEvidence,
    scoring: { kind: "boolean", passValue: true },
  });
  return Object.freeze({ name, slug, description, version: 1, definition });
}

export const factoryScorerPresets = Object.freeze({
  correctness: createPreset(
    "Correctness",
    "correctness",
    "Check whether the change satisfies the behavior described in its retained artifact.",
    ["artifact", "code_diff"],
    [
      "Identify the intended behavior and named edge cases in the retained artifact. Check the exact change against those claims.",
      "Return true when the visible change supports the stated behavior and does not introduce a concrete contradiction. Return false when you can cite a specific incorrect behavior, regression, or ignored requirement.",
      "Return an inconclusive result when the intended behavior is unclear or the retained change cannot establish the claim. Cite exact changed lines or artifact passages for material findings.",
    ].join("\n\n"),
  ),
  verification: createPreset(
    "Verification",
    "verification",
    "Check whether the retained validation report shows relevant, successful verification.",
    ["validation_report"],
    [
      "Use the retained report for the exact evaluated commit. Determine which checks actually ran, which claims they cover, and whether they passed.",
      "Return true when the report shows successful checks for the relevant behavior. Return false for a reported failing required check, or when the report explicitly shows required verification was skipped.",
      "Return an inconclusive result when the report is partial or the connection to the intended behavior is unclear. Cite the reported checks and their outcomes.",
    ].join("\n\n"),
  ),
  scope: createPreset(
    "Scope",
    "scope",
    "Check whether the diff stays within the stated task and its necessary dependencies.",
    ["artifact", "code_diff"],
    [
      "Identify the requested change from the retained artifact. Map material changes in the diff to that request, its validation, or a dependency required to deliver it.",
      "Return true when the material changes serve the requested work. Return false for a clearly unrelated feature, rewrite, or behavior change. Account for setup and compatibility changes when the diff makes their necessity clear.",
      "Return an inconclusive result when scope or the dependency relationship cannot be established. Cite the exact changed lines and the relevant scope statement.",
    ].join("\n\n"),
  ),
  "redundant-tests": createPreset(
    "Redundant tests and scaffolding",
    "redundant-tests",
    "Distinguish useful regression coverage from duplicate assertions and unnecessary setup.",
    ["code_diff"],
    [
      "Review changed tests and supporting setup in the exact code diff. Identify the behavior each new test establishes and whether it would detect a regression the visible existing tests miss.",
      "Return true when the diff adds meaningful regression coverage or contains no redundant test scaffolding. A narrowly scoped boundary, error, or lifecycle test can be useful even when nearby tests exercise the same function.",
      "Return false only when the diff shows a duplicate assertion or setup that does not affect the tested behavior. Cite the added code and the existing coverage or unused setup that proves redundancy.",
      "Return an inconclusive result when the diff omits the behavior, assertions, or context needed to tell whether the test is useful. Similar names, test size, and fixture count alone cannot establish redundancy.",
    ].join("\n\n"),
  ),
});

export type FactoryScorerPreset = (typeof factoryScorerPresets)[keyof typeof factoryScorerPresets];

export function factoryScorerPresetKey({ slug, version }: FactoryScorerPreset) {
  return `${slug}-v${version}`;
}

export function readFactoryScorerPreset(key: string | string[] | undefined) {
  return Object.values(factoryScorerPresets).find(
    (preset) => factoryScorerPresetKey(preset) === key,
  );
}
