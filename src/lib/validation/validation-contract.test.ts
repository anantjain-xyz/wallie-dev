import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyValidationContract } from "../../../scripts/verify-validation-contract";

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/fixtures/validation-contract", import.meta.url),
);

describe("validation contract verifier", () => {
  it("accepts canonical package profiles, PR delegation, and classified checks", () => {
    expect(verifyValidationContract(resolve(fixturesDirectory, "passing"))).toEqual([]);
  });

  it("rejects workflow drift even when comments and shell strings mention the canonical script", () => {
    const errors = verifyValidationContract(resolve(fixturesDirectory, "workflow-drift"));

    expect(errors).toContain(
      '.github/workflows/test.yml job "test" must delegate validation exactly once to "pnpm check" (found package-script calls: "test"). Replace duplicated or drifted validation commands with the canonical profile.',
    );
  });

  it("reports missing package scripts with a concrete repair", () => {
    const errors = verifyValidationContract(resolve(fixturesDirectory, "missing-script"));

    expect(errors).toContain(
      'Package script "check:fast" references missing package script "typecheck". Declare "typecheck" in package.json#scripts or update the validation contract reference.',
    );
  });
});
