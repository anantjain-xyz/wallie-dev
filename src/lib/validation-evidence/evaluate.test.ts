import { describe, expect, it } from "vitest";
import { evaluateValidationEvidence } from "./evaluate";
import type { ValidationEvidenceRecord } from "./contracts";
const sha = "a".repeat(40),
  tree = "b".repeat(40);
const record = (): ValidationEvidenceRecord => ({
  key: "unit",
  command: "pnpm test",
  provenance: "harness",
  status: "passed",
  exitCode: 0,
  startedAt: "2026-11-06T01:00:00Z",
  completedAt: "2026-11-06T01:01:00Z",
  commitSha: sha,
  treeSha: tree,
  finalCommitSha: sha,
  finalTreeSha: tree,
  reportKeys: ["unit/report"],
  missingRequiredReports: [],
});
const evaluate = (records: ValidationEvidenceRecord[], keys = new Set(["unit/report"])) =>
  evaluateValidationEvidence({
    requiredKeys: ["unit"],
    commitSha: sha,
    treeSha: tree,
    records,
    accessibleAssetKeys: keys,
  });
describe("validation receipt matching", () => {
  it("requires an observed record rather than markdown assertions", () =>
    expect(evaluate([])).toEqual([{ key: "unit", status: "missing" }]));
  it("accepts one exact harness receipt with accessible required assets", () =>
    expect(evaluate([record()])).toEqual([{ key: "unit", status: "passed" }]));
  it.each(["commitSha", "treeSha", "finalCommitSha", "finalTreeSha"] as const)(
    "invalidates %s mismatch",
    (field) =>
      expect(evaluate([{ ...record(), [field]: "c".repeat(40) }])).toEqual([
        { key: "unit", status: "stale" },
      ]),
  );
  it.each(["failed", "error", "stale"] as const)("rejects %s receipt", (status) =>
    expect(evaluate([{ ...record(), status }])[0].status).not.toBe("passed"),
  );
  it("rejects failed exit status, absent assets, and ambiguous duplicate receipts", () => {
    expect(evaluate([{ ...record(), exitCode: 1 }])[0].status).toBe("failed");
    expect(evaluate([record()], new Set())[0].status).toBe("unavailable");
    expect(evaluate([{ ...record(), missingRequiredReports: ["unit/report"] }])[0].status).toBe(
      "unavailable",
    );
    expect(evaluate([record(), record()])[0].status).toBe("missing");
  });
});
