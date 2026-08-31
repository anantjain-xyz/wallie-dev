import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const baseline = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);
const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260809000000_drop_github_issue_branches.sql"),
  "utf8",
);
const seed = readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8");
const databaseTypes = readFileSync(
  join(process.cwd(), "src/lib/supabase/database.types.ts"),
  "utf8",
);

describe("github_issue_branches removal migration", () => {
  it("keeps the consolidated baseline frozen and migrates legacy rows forward", () => {
    expect(baseline).toContain("create table public.github_issue_branches");
    expect(migration).toContain("insert into public.session_pull_requests");
    expect(migration).toContain("from public.github_issue_branches as legacy");
    expect(migration).toContain("on conflict (workspace_id, branch_name) do update");
    expect(migration).toContain("where excluded.updated_at > session_pull_requests.updated_at");
    expect(migration).toContain(
      "raise exception 'Not every github_issue_branches row was migrated'",
    );
  });

  it("removes the legacy relation and its dedicated enforcement function", () => {
    expect(migration).toContain("drop policy if exists github_issue_branches_select_membership");
    expect(migration).toContain("revoke all privileges on table public.github_issue_branches");
    expect(migration).toContain("drop trigger if exists github_issue_branches_enforce_refs");
    expect(migration).toContain(
      "drop index if exists public.github_issue_branches_session_created_at_idx",
    );
    expect(migration).toContain("drop table public.github_issue_branches");
    expect(migration).toContain("drop function internal.enforce_github_issue_branch_refs()");
    expect(databaseTypes).not.toContain("github_issue_branches");
  });

  it("seeds pull requests through the canonical table only", () => {
    expect(seed).toMatch(/insert into public\.session_pull_requests/i);
    expect(seed).not.toContain("public.github_issue_branches");
  });
});
