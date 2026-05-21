import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260521000000_add_session_repository.sql"),
  "utf8",
);

describe("session repository schema", () => {
  it("pins an optional repository on sessions", () => {
    expect(migration).toContain("github_repository_id uuid references public.github_repositories");
    expect(migration).toContain("sessions_github_repository_idx");
  });

  it("enforces same-workspace repository references", () => {
    expect(migration).toContain("internal.enforce_session_refs");
    expect(migration).toContain(
      "internal.assert_workspace_match(new.workspace_id, 'public.github_repositories', new.github_repository_id, 'github_repository_id')",
    );
  });
});
