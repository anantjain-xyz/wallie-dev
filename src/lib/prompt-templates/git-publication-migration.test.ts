import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260810134054_enforce_wallie_git_publication.sql"),
  "utf8",
);

describe("Wallie Git publication migration", () => {
  it("updates only the exact prior Build prompt", () => {
    expect(migration).toContain("with previous_default_build_prompt(value)");
    expect(migration).toContain("stage.prompt_template_md = previous_default_build_prompt.value");
    expect(migration).not.toContain("prompt_template_md = replace(");
  });

  it("makes the future Build default use the sandbox identity", () => {
    expect(migration).toContain("Preserve Wallie''s configured commit identity");
    expect(migration).toContain("sandbox `gh` CLI");
    expect(migration).toContain("injected `GH_TOKEN`");
  });
});
