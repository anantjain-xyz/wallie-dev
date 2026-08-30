import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260829232000_cursor_auth_flow_leases.sql"),
  "utf8",
);

describe("Cursor auth-flow lease migration", () => {
  it("guards credential publication by the current worker claim", () => {
    expect(migration).toContain("and claimed_by = p_claimed_by");
    expect(migration).toContain("drop function public.complete_cursor_auth_flow");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("from public, anon, authenticated");
  });
});
