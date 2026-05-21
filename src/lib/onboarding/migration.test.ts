import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("workspace onboarding schema", () => {
  it("creates exactly one onboarding row per workspace", () => {
    expect(migration).toContain("create table public.workspace_onboarding");
    expect(migration).toContain(
      "workspace_id uuid not null unique references public.workspaces(id) on delete cascade",
    );
  });

  it("seeds onboarding state inside create_workspace", () => {
    expect(migration).toContain("create or replace function public.create_workspace");
    expect(migration).toContain("insert into public.workspace_onboarding (workspace_id)");
    expect(migration).toContain("values (created_workspace.id);");
  });

  it("rejects unknown statuses and steps at the database boundary", () => {
    expect(migration).toContain(
      "status in ('not_started', 'in_progress', 'dismissed', 'completed')",
    );
    expect(migration).toContain(
      "current_step in ('github', 'repository', 'pipeline', 'linear', 'runtime', 'verify')",
    );
    expect(migration).toContain("constraint workspace_onboarding_known_completed_steps");
    expect(migration).toContain("constraint workspace_onboarding_known_skipped_steps");
  });

  it("allows members to read and only managers to mutate onboarding state", () => {
    expect(migration).toContain("grant select on public.workspace_onboarding to authenticated");
    expect(migration).toContain(
      "grant insert, update on public.workspace_onboarding to authenticated",
    );
    expect(migration).not.toContain("grant insert, update, delete on public.workspace_onboarding");
    expect(migration).toContain("workspace_onboarding_select_membership");
    expect(migration).toContain("workspace_id in (select internal.current_user_workspace_ids())");
    expect(migration).toContain("workspace_onboarding_insert_managers");
    expect(migration).toContain("workspace_onboarding_update_managers");
    expect(migration).toContain("internal.can_manage_workspace(workspace_id)");
  });
});
