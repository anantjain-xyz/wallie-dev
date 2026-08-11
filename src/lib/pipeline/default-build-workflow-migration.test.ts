import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260811040456_merge_default_build_workflow.sql"),
  "utf8",
);
const seed = readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8");

function defaultStageDefinition() {
  const definition = migration.match(
    /create or replace function internal\.default_pipeline_stages\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/,
  )?.[1];
  expect(definition).toBeDefined();
  return definition!;
}

describe("merged default build workflow migration", () => {
  it("seeds only Plan and Build for new workspaces", () => {
    const slugs = [...defaultStageDefinition().matchAll(/\(\s*\d+,\s*'([^']+)'/g)].map(
      (match) => match[1],
    );

    expect(slugs).toEqual(["plan", "build"]);
  });

  it("publishes a PR without self-reviewing, waiting, or merging", () => {
    const definition = defaultStageDefinition();
    expect(definition).toContain("Open the pull request");
    expect(definition).toContain("Stop after publication");
    expect(definition).toContain("Do not self-review the PR");
    expect(definition).toContain("or merge the PR");
    expect(definition).not.toContain("Sweep PR feedback");
  });

  it("defaults new routing rows to manual merge without backfilling existing rows", () => {
    expect(migration).toContain("alter column land_stage_slug drop not null");
    expect(migration).toContain("alter column land_stage_slug drop default");
    expect(migration).not.toMatch(/update\s+public\.workspace_linear_routing/i);
  });

  it("keeps the development seed as an explicit four-stage custom pipeline", () => {
    expect(seed).toContain("3, 'review', 'Review'");
    expect(seed).toContain("4, 'land', 'Land'");
    expect(seed).toContain("(routing_id, ws_id, 'land'");
  });
});
