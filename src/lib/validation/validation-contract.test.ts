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

  it("rejects canonical profiles that omit required validation components", () => {
    const errors = verifyValidationContract(resolve(fixturesDirectory, "incomplete-profile"));

    expect(errors).toEqual(
      expect.arrayContaining([
        'Package script "check:fast" must include "pnpm format:check" in the fast validation profile. Add it to keep the required PR contract enforced.',
        'Package script "check:fast" must include "pnpm lint" in the fast validation profile. Add it to keep the required PR contract enforced.',
        'Package script "check" must include "pnpm test" in the full validation profile. Add it to keep the required PR contract enforced.',
      ]),
    );
  });

  it("rejects skipped or non-blocking canonical workflow delegation", () => {
    const errors = verifyValidationContract(resolve(fixturesDirectory, "non-blocking-delegation"));

    expect(errors).toEqual(
      expect.arrayContaining([
        '.github/workflows/lint-and-format.yml job "lint-and-format" must run unconditionally for pull requests. Remove the job-level "if" condition so "pnpm check:fast" cannot be skipped.',
        '.github/workflows/lint-and-format.yml job "lint-and-format" must block pull requests when validation fails. Remove job-level "continue-on-error" or set it to false.',
        '.github/workflows/test.yml job "test" must run "pnpm check" unconditionally. Remove the validation step\'s "if" condition so the canonical profile cannot be skipped.',
        '.github/workflows/test.yml job "test" must treat "pnpm check" failures as blocking. Remove the validation step\'s "continue-on-error" or set it to false.',
      ]),
    );
  });

  it("rejects trigger, dependency, classified-control, and profile-classification bypasses", () => {
    const errors = verifyValidationContract(resolve(fixturesDirectory, "review-bypasses"));

    expect(errors).toEqual(
      expect.arrayContaining([
        '.github/workflows/lint-and-format.yml pull_request branches must include "main" so the fast validation profile protects the repository\'s default branch. Add "main" or remove the branch filter.',
        '.github/workflows/lint-and-format.yml must not filter pull_request paths because relevant changes could skip the fast validation profile. Remove "paths" and "paths-ignore" from the pull_request trigger.',
        '.github/workflows/lint-and-format.yml pull_request types must include "opened", "synchronize", and "reopened" so the fast validation profile runs on ordinary PR updates. Remove the "types" filter or add the missing event types.',
        '.github/workflows/lint-and-format.yml job "lint-and-format" must not depend on another job because a skipped dependency can suppress required validation. Remove the job-level "needs" dependency.',
        'Package script "check:fast" must not include classified environment-dependent command "pnpm db:types". Remove it from the fast validation profile or remove its explicit classification.',
        '.github/workflows/test.yml job "route-budgets" must run unconditionally for pull requests while classified as route-budget. Remove the job-level "if" condition.',
        '.github/workflows/test.yml job "route-budgets" must block pull requests while classified as route-budget. Remove job-level "continue-on-error" or set it to false.',
        '.github/workflows/test.yml job "route-budgets" must run "pnpm build" unconditionally while classified as route-budget. Remove the check step\'s "if" condition.',
        '.github/workflows/test.yml job "route-budgets" must treat "pnpm check:route-budgets" failures as blocking while classified as route-budget. Remove the check step\'s "continue-on-error" or set it to false.',
      ]),
    );
  });
});
