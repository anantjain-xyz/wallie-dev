import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260717000002_pipeline_dashboard_page.sql"),
  "utf8",
);

describe("Pipeline dashboard migration", () => {
  it("bounds pages and ranks attention before stable update/id keys", () => {
    expect(migration).toContain("least(greatest(coalesce(page_limit, 25), 1), 25)");
    expect(migration).toContain("order by ss.attention_rank asc, ss.updated_at desc, ss.id desc");
    expect(migration).toContain("s.updated_at <= v_snapshot_at");
    expect(migration).toContain("ss.id < cursor_id");
  });

  it("keeps lane identity pinned to both the session pipeline and current stage", () => {
    expect(migration).toContain("s.pipeline_id = p.id");
    expect(migration).toContain("ld.pipeline_id = s.pipeline_id");
    expect(migration).toContain("ld.stage_id = s.current_stage_id");
    expect(migration).not.toContain("prompt_template_md");
    expect(migration).not.toContain("approver_member_ids");
  });

  it("includes custom default stages even when their lanes are empty", () => {
    expect(migration).toContain("from public.pipelines p");
    expect(migration).toContain("and p.is_default");
    expect(migration).toContain("left join lane_counts lc");
    expect(migration).toContain("coalesce(lc.total_count, 0)");
  });
});
