import type { FactoryScorerEvidenceKind } from "@/lib/factory-scorers/contracts";

export const scorerEvidenceLabels = {
  code_diff: "Code diff",
  artifact: "Artifact",
  validation_report: "Validation report",
  browser_screenshot: "Browser screenshot",
  browser_recording: "Browser recording",
} satisfies Record<FactoryScorerEvidenceKind, string>;
