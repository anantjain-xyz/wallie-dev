import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const databaseTypes = readFileSync(
  join(process.cwd(), "src/lib/supabase/database.types.ts"),
  "utf8",
);

describe("github_issue_branches removal", () => {
  it("regenerates types without the legacy relation", () => {
    expect(databaseTypes).not.toContain("github_issue_branches");
  });
});
