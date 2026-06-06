import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const skippedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "node_modules",
]);
const skippedExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

function listFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];

  for (const entry of entries) {
    if (skippedDirectories.has(entry)) {
      continue;
    }

    const path = join(directory, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...listFiles(path));
    } else if (!skippedExtensions.has(extname(entry).toLowerCase())) {
      files.push(path);
    }
  }

  return files;
}

describe("domain purge", () => {
  it("keeps the legacy domain out of repository text", () => {
    const forbiddenPattern = new RegExp(["wallie", "cc"].join("\\."), "i");
    const matches = listFiles(process.cwd()).flatMap((path) => {
      const content = readFileSync(path, "utf8");

      return forbiddenPattern.test(content) ? [relative(process.cwd(), path)] : [];
    });

    expect(matches).toEqual([]);
  });
});
