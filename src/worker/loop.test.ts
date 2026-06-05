import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";

const mocked = vi.hoisted(() => ({
  processPipelineJob: vi.fn(),
  sendHeartbeat: vi.fn(),
}));

vi.mock("@/lib/pipeline/processor", () => ({
  processPipelineJob: mocked.processPipelineJob,
}));

vi.mock("./heartbeat", () => ({
  sendHeartbeat: mocked.sendHeartbeat,
}));

import { pollOnce } from "./loop";

const config: WorkerConfig = {
  defaultConcurrencyLimit: 2,
  defaultStallTimeoutMs: 900_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 2_000,
  reconcileIntervalMs: 60_000,
  sandboxReapIntervalMs: 60_000,
  stallSweepIntervalMs: 30_000,
  workerId: "worker-test",
};

const baseJob = {
  attempt_count: 1,
  created_at: "2026-06-05T00:00:00.000Z",
  dedupe_key: null,
  finished_at: null,
  id: "job-1",
  job_type: "session",
  last_error: null,
  requested_by_member_id: "member-1",
  scheduled_at: null,
  session_id: "session-1",
  stage_id: "stage-1",
  stage_name: "Build",
  stage_slug: "build",
  started_at: null,
  status: "queued",
  trigger_type: "assignment",
  updated_at: "2026-06-05T00:00:00.000Z",
  workspace_id: "workspace-1",
};

describe("pollOnce", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("filters out future scheduled jobs before limiting candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T12:00:00.000Z"));

    const calls: Array<{ args: unknown[]; method: string }> = [];
    const query = {
      eq: vi.fn((column: string, value: string) => {
        calls.push({ args: [column, value], method: "eq" });
        return query;
      }),
      limit: vi.fn(async (count: number) => {
        calls.push({ args: [count], method: "limit" });
        return { data: [], error: null };
      }),
      or: vi.fn((filter: string) => {
        calls.push({ args: [filter], method: "or" });
        return query;
      }),
      order: vi.fn((column: string, options: { ascending: boolean }) => {
        calls.push({ args: [column, options], method: "order" });
        return query;
      }),
      select: vi.fn((selection: string) => {
        calls.push({ args: [selection], method: "select" });
        return query;
      }),
    };
    const admin = {
      from: vi.fn((table: string) => {
        expect(table).toBe("agent_jobs");
        return query;
      }),
    };

    const result = await pollOnce(admin as never, config);

    expect(result).toEqual({ jobId: null, outcome: "idle" });
    expect(query.or).toHaveBeenCalledWith(
      "scheduled_at.is.null,scheduled_at.lte.2026-06-05T12:00:00.000Z",
    );
    expect(calls.findIndex((call) => call.method === "or")).toBeLessThan(
      calls.findIndex((call) => call.method === "limit"),
    );
  });

  it("claims and processes the first ready candidate", async () => {
    const claimedJob = { ...baseJob, status: "started" };
    const activeJobIds: Array<string | null> = [];
    mocked.processPipelineJob.mockResolvedValue(undefined);
    mocked.sendHeartbeat.mockResolvedValue(undefined);

    const jobQuery = {
      eq: vi.fn(() => jobQuery),
      limit: vi.fn(async () => ({ data: [baseJob], error: null })),
      or: vi.fn(() => jobQuery),
      order: vi.fn(() => jobQuery),
      select: vi.fn(() => jobQuery),
    };
    const runStatusUpdate = {
      in: vi.fn(async () => ({ error: null })),
    };
    const runJobFilter = {
      eq: vi.fn(() => runStatusUpdate),
    };
    const runQuery = {
      update: vi.fn(() => runJobFilter),
    };
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "agent_jobs") {
          return jobQuery;
        }
        if (table === "agent_runs") {
          return runQuery;
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(async () => ({ data: [claimedJob], error: null })),
    };

    const result = await pollOnce(admin as never, config, {
      setActiveJobId: (jobId) => activeJobIds.push(jobId),
    });

    expect(result).toEqual({ jobId: "job-1", outcome: "success" });
    expect(admin.rpc).toHaveBeenCalledWith("claim_agent_job", {
      default_concurrency_limit: 2,
      target_job_id: "job-1",
    });
    expect(mocked.processPipelineJob).toHaveBeenCalledWith({
      admin,
      job: claimedJob,
    });
    expect(mocked.sendHeartbeat).toHaveBeenCalledWith(admin, "worker-test", "job-1");
    expect(mocked.sendHeartbeat).toHaveBeenCalledWith(admin, "worker-test", null);
    expect(activeJobIds).toEqual(["job-1", null]);
  });
});
