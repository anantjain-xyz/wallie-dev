import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const databaseTypes = readFileSync(
  join(process.cwd(), "src/lib/supabase/database.types.ts"),
  "utf8",
);

describe("agent_jobs discriminator removal", () => {
  it("regenerates agent_jobs types without the removed discriminator", () => {
    expect(databaseTypes).not.toContain("job_type");
  });
});
