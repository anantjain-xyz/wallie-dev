import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260606000001_add_user_github_identities.sql"),
  "utf8",
);

describe("user GitHub identities schema", () => {
  it("creates one GitHub commit author identity per user", () => {
    expect(migration).toContain("create table if not exists public.user_github_identities");
    expect(migration).toContain("user_id uuid primary key references auth.users(id)");
    expect(migration).toContain("github_user_id bigint not null");
    expect(migration).toContain("author_email_source in ('github_noreply')");
  });

  it("uses service-role writes and self read/delete policies", () => {
    expect(migration).toContain("grant all on public.user_github_identities to service_role");
    expect(migration).toContain(
      "grant select, delete on public.user_github_identities to authenticated",
    );
    expect(migration).not.toContain(
      "grant insert, update on public.user_github_identities to authenticated",
    );
    expect(migration).toContain("user_github_identities_select_self");
    expect(migration).toContain("user_id = auth.uid()");
  });
});
