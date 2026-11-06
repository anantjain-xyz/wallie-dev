import type { ValidationEvidenceRecord } from "./contracts";

/** Validation-only receipt check. PR readiness also needs GitHub and review inputs (OP-508). */
export function evaluateValidationEvidence(input: {
  requiredKeys: string[];
  commitSha: string;
  treeSha: string;
  records: ValidationEvidenceRecord[];
  accessibleAssetKeys: ReadonlySet<string>;
}) {
  return input.requiredKeys.map((key) => {
    const matches = input.records.filter((record) => record.key === key);
    const record = matches.length === 1 ? matches[0] : undefined;
    if (!record) return { key, status: "missing" as const };
    if (
      record.commitSha !== input.commitSha ||
      record.treeSha !== input.treeSha ||
      record.finalCommitSha !== input.commitSha ||
      record.finalTreeSha !== input.treeSha ||
      record.status === "stale"
    )
      return { key, status: "stale" as const };
    if (record.provenance !== "harness" || record.exitCode !== 0 || record.status !== "passed")
      return { key, status: "failed" as const };
    if (
      record.missingRequiredReports.length ||
      record.reportKeys.some((asset) => !input.accessibleAssetKeys.has(asset))
    )
      return { key, status: "unavailable" as const };
    return { key, status: "passed" as const };
  });
}
