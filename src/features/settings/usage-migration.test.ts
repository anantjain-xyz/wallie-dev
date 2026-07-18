import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260717000002_add_workspace_usage_aggregate.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const initMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("workspace usage aggregate migration", () => {
  it("adds the RPC through a forward-only migration", () => {
    expect(initMigration).not.toContain("get_workspace_usage");
    expect(migration).toContain("create or replace function public.get_workspace_usage");
    expect(migration).toContain("returns table (");
    expect(migration).toContain("total_input_tokens bigint");
    expect(migration).toContain("total_output_tokens bigint");
    expect(migration).toContain("total_cost_usd numeric");
    expect(migration).toContain("total_runs bigint");
  });

  it("aggregates only successful workspace runs into one permission-aware row", () => {
    expect(migration).toContain("create index agent_runs_workspace_success_usage_idx");
    expect(migration).toContain("on public.agent_runs (workspace_id)");
    expect(migration).toContain("include (input_tokens, output_tokens, total_cost_usd)");
    expect(migration).toContain("where status = 'success'");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("internal.current_user_workspace_ids()");
    expect(migration).toContain("run.workspace_id = permitted_workspace.workspace_id");
    expect(migration).toContain("run.status = 'success'");
    expect(migration).toContain("coalesce(sum(run.input_tokens), 0)");
    expect(migration).toContain("coalesce(sum(run.output_tokens), 0)");
    expect(migration).toContain("coalesce(sum(run.total_cost_usd), 0)");
    expect(migration).toContain("count(run.id)");
    expect(migration).toContain("group by permitted_workspace.workspace_id");
  });

  it("keeps anonymous callers out and grants only authenticated boundaries", () => {
    expect(migration).toContain(
      "revoke all on function public.get_workspace_usage(uuid) from public, anon",
    );
    expect(migration).toContain(
      "grant execute on function public.get_workspace_usage(uuid) to authenticated, service_role",
    );
  });
});
