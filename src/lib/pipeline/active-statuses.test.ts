import { describe, expect, it } from "vitest";

import {
  ACTIVE_AGENT_JOB_STATUSES,
  ACTIVE_AGENT_RUN_STATUSES,
  isActiveAgentJobStatus,
  isActiveAgentRunStatus,
} from "./cancel";

// The partial unique index `agent_jobs_active_dedupe_key_idx` and every RPC
// status guard in supabase/migrations spell the active set as
// `('queued', 'started', 'running')`. The TypeScript constants must match it
// exactly, `started` included: it has no production writers, but a legacy row
// carrying it must still be treated as live by dedupe and cancel guards.
describe("active agent status constants", () => {
  it("match the database's active-status predicate", () => {
    expect([...ACTIVE_AGENT_JOB_STATUSES]).toEqual(["queued", "started", "running"]);
    expect([...ACTIVE_AGENT_RUN_STATUSES]).toEqual(["queued", "started", "running"]);
  });

  it("classify every enum value on the correct side of the active boundary", () => {
    for (const status of ["queued", "started", "running"] as const) {
      expect(isActiveAgentJobStatus(status)).toBe(true);
      expect(isActiveAgentRunStatus(status)).toBe(true);
    }
    for (const status of ["success", "error", "canceled"] as const) {
      expect(isActiveAgentJobStatus(status)).toBe(false);
      expect(isActiveAgentRunStatus(status)).toBe(false);
    }
  });
});
