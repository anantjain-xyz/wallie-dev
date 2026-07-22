import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260722000000_any_workspace_member_stage_approval.sql"),
  "utf8",
);

describe("pipeline stage approval policy migration", () => {
  it("preserves existing stages while defaulting future seeded stages to anyone", () => {
    const backfillIndex = migration.indexOf(
      "add column if not exists anyone_can_approve boolean not null default false",
    );
    const futureDefaultIndex = migration.indexOf(
      "alter column anyone_can_approve set default true",
    );

    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(futureDefaultIndex).toBeGreaterThan(backfillIndex);
  });

  it("keeps policy-less API-created stages restrictive", () => {
    expect(migration).toContain("existing_stage_ids uuid[]");
    expect(migration).toContain(
      "when nullif(payload.stage ->> 'id', '')::uuid = any(existing_stage_ids)",
    );
    expect(migration).toContain("else false");
  });
});
