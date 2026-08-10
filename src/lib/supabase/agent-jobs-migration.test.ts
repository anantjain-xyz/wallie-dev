import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const baseline = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);
const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260810150000_remove_agent_job_type.sql"),
  "utf8",
);
const databaseTypes = readFileSync(
  join(process.cwd(), "src/lib/supabase/database.types.ts"),
  "utf8",
);

describe("agent_jobs discriminator removal migration", () => {
  it("keeps the consolidated baseline frozen and removes the legacy index and constraint forward", () => {
    expect(baseline).toContain("job_type text not null default 'session'");
    expect(migration).toContain("drop index if exists public.agent_jobs_job_type_status_idx");
    expect(migration).toContain(
      "drop constraint if exists agent_jobs_job_type_pipeline_only_check",
    );
    expect(migration).toContain("drop column if exists job_type");
  });

  it("regenerates agent_jobs types without the removed discriminator", () => {
    expect(databaseTypes).not.toContain("job_type");
  });
});
