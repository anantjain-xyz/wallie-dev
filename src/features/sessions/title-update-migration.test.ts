import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260717000000_allow_member_session_title_updates.sql"),
  "utf8",
);
const titleInvariantMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260717000001_enforce_nonblank_session_titles.sql"),
  "utf8",
);

describe("session title update permissions", () => {
  it("grants only title updates and keeps writes membership-scoped", () => {
    expect(migration).toContain("grant update (title) on public.sessions to authenticated");
    expect(migration).toContain("create policy sessions_update_title_membership");
    expect(migration.match(/internal\.current_user_workspace_ids\(\)/g)).toHaveLength(2);
    expect(migration).not.toContain("grant update on public.sessions");
  });

  it("rejects blank titles written outside the validated route", () => {
    expect(titleInvariantMigration).toContain("add constraint sessions_title_not_blank");
    expect(titleInvariantMigration).toContain("check (title ~ '[^[:space:]]') not valid");
  });
});
