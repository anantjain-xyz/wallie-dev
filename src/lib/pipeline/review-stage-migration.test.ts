import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260607000001_review_stage_feedback_loop.sql"),
  "utf8",
);
const seed = readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8");

describe("review stage feedback loop migration", () => {
  it("treats Review as a review-and-fix loop for bot and human feedback", () => {
    for (const content of [migration, seed]) {
      expect(content).toContain("review-and-fix loop");
      expect(content).toContain("bots and humans");
      expect(content).toContain("Code changes are allowed");
      expect(content).toContain("Loop until clear");
    }
  });

  it("replaces legacy prompts while preserving custom Review prompt content", () => {
    expect(migration).toContain("where stage.slug = 'review'");
    expect(migration).toContain("legacy_full_review_prompt");
    expect(migration).toContain("legacy_demo_review_prompt");
    expect(migration).toContain("chr(8212)");
    expect(migration).toContain("review_loop_addendum");
    expect(migration).toContain("stage.prompt_template_md ||");
  });
});
