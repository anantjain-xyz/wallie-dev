import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("workspace repository profiles schema", () => {
  it("creates one selected profile per repository and one primary per workspace", () => {
    expect(migration).toContain("create table public.workspace_repository_profiles");
    expect(migration).toContain("unique (workspace_id, github_repository_id)");
    expect(migration).toContain("workspace_repository_profiles_one_primary_per_workspace");
    expect(migration).toContain("where is_primary");
  });

  it("stores static inference metadata with confidence validation", () => {
    expect(migration).toContain("language_hints text[] not null default '{}'");
    expect(migration).toContain("env_key_suggestions text[] not null default '{}'");
    expect(migration).toContain("inference_sources jsonb not null default '[]'::jsonb");
    expect(migration).toContain("inference_confidence in ('low', 'medium', 'high', 'manual')");
  });

  it("enforces same-workspace repository references", () => {
    expect(migration).toContain("internal.enforce_workspace_repository_profile_refs");
    expect(migration).toContain("'public.github_repositories'");
    expect(migration).toContain("'github_repository_id'");
  });

  it("allows members to read and only managers to mutate profiles", () => {
    expect(migration).toContain(
      "grant select on public.workspace_repository_profiles to authenticated",
    );
    expect(migration).toContain(
      "grant insert, update, delete on public.workspace_repository_profiles",
    );
    expect(migration).toContain("workspace_repository_profiles_select_membership");
    expect(migration).toContain("workspace_repository_profiles_insert_managers");
    expect(migration).toContain("workspace_repository_profiles_update_managers");
    expect(migration).toContain("workspace_repository_profiles_delete_managers");
    expect(migration).toContain("public.can_manage_workspace(workspace_id)");
  });

  it("provides an atomic save function for switching the primary profile", () => {
    expect(migration).toContain(
      "create or replace function public.save_workspace_repository_profile",
    );
    expect(migration).toContain("returns public.workspace_repository_profiles");
    expect(migration).toContain("update public.workspace_repository_profiles");
    expect(migration).toContain("on conflict (workspace_id, github_repository_id)");
    expect(migration).toContain(
      "grant execute on function public.save_workspace_repository_profile",
    );
  });
});
