import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatDocumentationDiagnostics,
  verifyDocumentationContract,
} from "../../../scripts/verify-documentation-contract";

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/fixtures/documentation-contract", import.meta.url),
);
const temporaryDirectories: string[] = [];

function verifyFixture(
  name:
    | "bad-anchor"
    | "broken-path"
    | "comment-string-false-green"
    | "duplicate-index"
    | "machine-local-path"
    | "missing-command"
    | "missing-index"
    | "passing",
) {
  if (name === "passing") {
    return verifyDocumentationContract(resolve(fixturesDirectory, name));
  }

  const projectDirectory = mkdtempSync(join(tmpdir(), "wallie-documentation-contract-"));
  temporaryDirectories.push(projectDirectory);
  cpSync(resolve(fixturesDirectory, "passing"), projectDirectory, { recursive: true });
  cpSync(resolve(fixturesDirectory, name), projectDirectory, {
    force: true,
    recursive: true,
  });
  return verifyDocumentationContract(projectDirectory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("documentation contract verifier", () => {
  it("accepts reference-style links and ignores fenced examples", () => {
    expect(verifyFixture("passing")).toEqual([]);
  });

  it("rejects a missing Task map entry", () => {
    expect(verifyFixture("missing-index")).toEqual([
      expect.objectContaining({
        document: "docs/README.md",
        invariant: "docs-index",
        message: "docs/GUIDE.md is not indexed in the Task map.",
      }),
    ]);
  });

  it("rejects a duplicate Task map entry", () => {
    expect(verifyFixture("duplicate-index")).toEqual([
      expect.objectContaining({
        document: "docs/README.md",
        invariant: "docs-index",
        message: "docs/GUIDE.md is indexed 2 times in the Task map.",
      }),
    ]);
  });

  it("rejects a bad Markdown anchor", () => {
    expect(verifyFixture("bad-anchor")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "markdown-anchor",
        message: 'Markdown anchor "#missing-heading" does not exist in docs/README.md.',
      }),
    ]);
  });

  it("rejects broken links and referenced code paths", () => {
    expect(verifyFixture("broken-path")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document: "docs/GUIDE.md",
          invariant: "repository-link",
        }),
        expect.objectContaining({
          document: "docs/GUIDE.md",
          invariant: "repository-path",
        }),
      ]),
    );
  });

  it("does not let HTML comments or fenced strings satisfy the index", () => {
    const diagnostics = verifyFixture("comment-string-false-green");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      invariant: "docs-index",
      message: "docs/GUIDE.md is not indexed in the Task map.",
    });
  });

  it("rejects machine-local absolute paths outside fenced examples", () => {
    expect(verifyFixture("machine-local-path")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "portable-path",
      }),
    ]);
  });

  it("requires documented package commands to be script declarations", () => {
    expect(verifyFixture("missing-command")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "declared-package-command",
        message:
          'Documented package command "pnpm missing:command" is not declared in package.json#scripts.',
      }),
    ]);
  });

  it("formats the document, invariant, and direct repair", () => {
    const output = formatDocumentationDiagnostics(verifyFixture("bad-anchor"));

    expect(output).toContain("docs/GUIDE.md:3 [markdown-anchor]");
    expect(output).toContain("Repair: Use the target heading's generated anchor");
  });

  it("keeps the repository documentation within the contract", () => {
    expect(verifyDocumentationContract(process.cwd())).toEqual([]);
  });
});
