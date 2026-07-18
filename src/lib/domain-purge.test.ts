import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

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

function listTrackedTextFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd() })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => existsSync(join(process.cwd(), path)))
    .filter((path) => statSync(join(process.cwd(), path)).isFile())
    .filter((path) => !skippedExtensions.has(extname(path).toLowerCase()));
}

describe("domain purge", () => {
  it("keeps the legacy domain out of repository text", () => {
    const forbiddenPattern = new RegExp(["wallie", "cc"].join("\\."), "i");
    const matches = listTrackedTextFiles().flatMap((path) => {
      const content = readFileSync(join(process.cwd(), path), "utf8");

      return forbiddenPattern.test(content) ? [path] : [];
    });

    expect(matches).toEqual([]);
  });
});
