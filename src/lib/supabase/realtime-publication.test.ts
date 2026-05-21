import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(currentDir, "../../../supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("Supabase Realtime publication", () => {
  it("publishes every table the session detail page subscribes to", () => {
    expect(migrationSql).toContain("'public.sessions'");
    expect(migrationSql).toContain("'public.agent_runs'");
    expect(migrationSql).toContain("'public.agent_run_messages'");
    expect(migrationSql).toContain("'public.session_artifacts'");
    expect(migrationSql).toContain("'public.session_phase_completions'");
    expect(migrationSql).toContain("'public.session_pull_requests'");
  });
});
