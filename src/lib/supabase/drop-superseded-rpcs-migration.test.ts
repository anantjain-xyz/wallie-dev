import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260809000001_drop_superseded_service_role_rpcs.sql"),
  "utf8",
);
const baseline = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);

describe("superseded service-role RPC removal migration", () => {
  it("removes the obsolete job-claim function and its grants", () => {
    expect(migration).toContain("revoke all on function public.claim_agent_job(uuid, integer)");
    expect(migration).toContain("from public, anon, authenticated, service_role");
    expect(migration).toContain("drop function public.claim_agent_job(uuid, integer)");
  });

  it("removes the obsolete session-number function and its grants", () => {
    expect(migration).toContain("revoke all on function public.next_session_number(uuid, uuid)");
    expect(migration).toContain("from public, anon, authenticated, service_role");
    expect(migration).toContain("drop function public.next_session_number(uuid, uuid)");
  });

  it("leaves the historical baseline intact", () => {
    expect(baseline).toContain("create or replace function public.claim_agent_job");
    expect(baseline).toContain("create or replace function public.next_session_number");
  });
});
