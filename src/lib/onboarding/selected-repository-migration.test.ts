import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("workspace onboarding selected repository schema", () => {
  it("adds the selected repository reference to onboarding state", () => {
    expect(migration).toContain("selected_github_repository_id uuid");
    expect(migration).toContain("references public.github_repositories(id) on delete set null");
    expect(migration).toContain("workspace_onboarding_selected_repository_idx");
  });

  it("enforces same-workspace repository references", () => {
    expect(migration).toContain("internal.enforce_workspace_onboarding_selected_repository_ref");
    expect(migration).toContain("'public.github_repositories'");
    expect(migration).toContain("'selected_github_repository_id'");
    expect(migration).toContain("workspace_onboarding_enforce_selected_repository_ref");
  });
});
