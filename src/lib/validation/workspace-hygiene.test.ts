import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyWorkspaceHygiene } from "../../../scripts/verify-workspace-hygiene";

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/fixtures/workspace-hygiene", import.meta.url),
);
const temporaryDirectories: string[] = [];

function verifyFixture(
  name: "missing-ignores" | "overbroad-ignore" | "passing" | "tracked-artifacts",
) {
  const projectDirectory = mkdtempSync(join(tmpdir(), "wallie-workspace-hygiene-"));
  temporaryDirectories.push(projectDirectory);
  cpSync(resolve(fixturesDirectory, "passing"), projectDirectory, { recursive: true });
  if (name !== "passing") {
    cpSync(resolve(fixturesDirectory, name), projectDirectory, {
      force: true,
      recursive: true,
    });
  }
  const trackedPaths = JSON.parse(
    readFileSync(resolve(projectDirectory, "tracked-files.json"), "utf8"),
  ) as string[];
  return verifyWorkspaceHygiene(projectDirectory, { trackedPaths });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("workspace hygiene verifier", () => {
  it("accepts bounded ignore ownership without hiding similarly named source paths", () => {
    expect(verifyFixture("passing")).toEqual([]);
  });

  it("names the missing path and owning ignore file", () => {
    expect(verifyFixture("missing-ignores")).toEqual([
      'Workspace hygiene path ".playwright-cli/" is not owned by .gitignore; add the bounded pattern "/.playwright-cli/".',
      'Workspace hygiene path ".playwright-cli/" is not owned by .prettierignore; add the bounded pattern "/.playwright-cli/".',
      'Workspace hygiene path "supabase/.temp/" is not owned by eslint.config.mjs; add the bounded pattern "supabase/.temp/**".',
    ]);
  });

  it("rejects ignore rules that hide a legitimate similarly named source directory", () => {
    expect(verifyFixture("overbroad-ignore")).toContain(
      'Legitimate source path "src/lib/.omo/example.ts" is hidden by .gitignore pattern ".omo/"; replace it with the bounded pattern "/.omo/".',
    );
  });

  it("rejects tracked caches, temporary preview routes, test results, and proof artifacts", () => {
    expect(verifyFixture("tracked-artifacts")).toEqual([
      'Tracked workspace artifact ".pnpm-store/store.json" is prohibited; .gitignore owns it via "/.pnpm-store/". Remove the path from Git\'s index.',
      'Tracked workspace artifact "src/app/preview/page.tsx" is prohibited; .gitignore owns it via "/src/app/preview/". Remove the path from Git\'s index.',
      'Tracked workspace artifact "test-results/results.json" is prohibited; .gitignore owns it via "/test-results/". Remove the path from Git\'s index.',
      'Tracked workspace artifact ".symphony/screenshots/01-happy-path.png" is prohibited; .gitignore owns it via "/.symphony/screenshots/". Remove the path from Git\'s index.',
    ]);
  });
});
