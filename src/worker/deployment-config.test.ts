import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

/** Follow local imports, including imports outside the current worker folders. */
function workerFiles(root: string): Set<string> {
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const pending = [
    "src/worker/index.ts",
    "scripts/install-crash-handlers.mjs",
    "scripts/register-server-only.mjs",
  ];
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const absolute = resolve(root, path);
    for (const dependency of ts.preProcessFile(readFileSync(absolute, "utf8"), true, true)
      .importedFiles) {
      const resolved = ts.resolveModuleName(
        dependency.fileName,
        absolute,
        options,
        ts.sys,
      ).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      pending.push(relative(root, resolved.resolvedFileName));
    }
  }
  return visited;
}

describe("Railway worker deployment", () => {
  it("watches every reachable worker module and runtime configuration", () => {
    const root = process.cwd();
    const config = JSON.parse(readFileSync(resolve(root, "railway.json"), "utf8")) as {
      build: { watchPatterns: string[] };
    };
    const files = workerFiles(root);
    expect(files.size).toBeGreaterThan(50);
    for (const path of ["package.json", "pnpm-lock.yaml", "railway.json", "tsconfig.json"])
      files.add(path);
    const uncovered = [...files].filter(
      (path) =>
        !config.build.watchPatterns.some((pattern) =>
          pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
        ),
    );
    expect(uncovered).toEqual([]);
  });
});
