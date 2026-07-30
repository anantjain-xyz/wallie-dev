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
    | "html-link"
    | "image-index"
    | "linux-machine-local-path"
    | "machine-local-path"
    | "missing-command"
    | "missing-index"
    | "passing"
    | "question-glob"
    | "root-path",
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
  it("accepts Markdown variants, pnpm built-ins and options, and valid code paths", () => {
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

  it("does not let an image satisfy a Task map entry", () => {
    const diagnostics = verifyFixture("image-index");

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

  it("rejects Linux home paths in prose and link targets", () => {
    expect(verifyFixture("linux-machine-local-path")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "portable-path",
        line: 3,
      }),
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "portable-path",
        line: 5,
      }),
    ]);
  });

  it("rejects broken repository-relative HTML links and images", () => {
    expect(verifyFixture("html-link")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "repository-link",
        message: 'Repository-relative link "../src/missing-html.ts" does not resolve.',
      }),
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "repository-link",
        message: 'Repository-relative link "../public/missing.png" does not resolve.',
      }),
    ]);
  });

  it("implements single-character matching in referenced path globs", () => {
    expect(verifyFixture("question-glob")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "repository-path",
        message: 'Referenced code path "src/missing?.ts" does not resolve.',
      }),
    ]);
  });

  it("validates referenced root-level repository paths", () => {
    expect(verifyFixture("root-path")).toEqual([
      expect.objectContaining({
        document: "docs/GUIDE.md",
        invariant: "repository-path",
        message: 'Referenced code path "missing.config.ts" does not resolve.',
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
