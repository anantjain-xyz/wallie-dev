import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, "../../../supabase/migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");

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
