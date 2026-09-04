import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { verifyValidationContract } from "../../../scripts/verify-validation-contract";

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/fixtures/validation-contract", import.meta.url),
);
const temporaryDirectories: string[] = [];

function verifyFixture(name: "missing-script" | "passing" | "workflow-drift") {
  if (name === "passing") {
    return verifyValidationContract(resolve(fixturesDirectory, name));
  }

  const projectDirectory = mkdtempSync(join(tmpdir(), "wallie-validation-contract-"));
  temporaryDirectories.push(projectDirectory);
  cpSync(resolve(fixturesDirectory, "passing"), projectDirectory, { recursive: true });
  cpSync(resolve(fixturesDirectory, name), projectDirectory, {
    force: true,
    recursive: true,
  });
  return verifyValidationContract(projectDirectory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("validation contract verifier", () => {
  it("accepts the exact package and workflow contract", () => {
    expect(verifyFixture("passing")).toEqual([]);
  });

  it("rejects workflow drift with a direct repair", () => {
    expect(verifyFixture("workflow-drift")).toContain(
      '.github/workflows/test.yml drifted from its approved exact shape. Restore the direct "pnpm check" delegation and approved trigger, permissions, job, and step controls; update the explicit contract only when that required check intentionally changes.',
    );
  });

  it.each(["if", "continue-on-error"])("rejects a database gate bypass using %s", (control) => {
    const projectDirectory = mkdtempSync(join(tmpdir(), "wallie-validation-contract-"));
    temporaryDirectories.push(projectDirectory);
    cpSync(resolve(fixturesDirectory, "passing"), projectDirectory, { recursive: true });
    const workflowPath = join(projectDirectory, ".github/workflows/test.yml");
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    workflow.jobs["database-tests"][control] = control === "if" ? "false" : true;
    writeFileSync(workflowPath, stringify(workflow));
    expect(verifyValidationContract(projectDirectory)).toContain(
      '.github/workflows/test.yml drifted from its approved exact shape. Restore the direct "pnpm check" delegation and approved trigger, permissions, job, and step controls; update the explicit contract only when that required check intentionally changes.',
    );
  });

  it("rejects a missing package script with its exact repair", () => {
    expect(verifyFixture("missing-script")).toContain(
      'Validation contract references missing package script "typecheck". Restore "typecheck" in package.json#scripts with command "tsc --noEmit".',
    );
  });
});
