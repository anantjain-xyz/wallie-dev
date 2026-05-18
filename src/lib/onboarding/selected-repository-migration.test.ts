import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260518000000_workspace_onboarding_selected_repository.sql",
  ),
  "utf8",
);

describe("workspace onboarding selected repository migration", () => {
  it("adds the selected repository reference to onboarding state", () => {
    expect(migration).toContain("add column selected_github_repository_id uuid");
    expect(migration).toContain("references public.github_repositories(id) on delete set null");
    expect(migration).toContain("workspace_onboarding_selected_repository_idx");
  });

  it("backfills from the current primary repository profile", () => {
    expect(migration).toContain("from public.workspace_repository_profiles profile");
    expect(migration).toContain("profile.workspace_id = onboarding.workspace_id");
    expect(migration).toContain("profile.is_primary");
  });

  it("enforces same-workspace repository references", () => {
    expect(migration).toContain("internal.enforce_workspace_onboarding_selected_repository_ref");
    expect(migration).toContain("'public.github_repositories'");
    expect(migration).toContain("'selected_github_repository_id'");
    expect(migration).toContain("workspace_onboarding_enforce_selected_repository_ref");
  });
});
