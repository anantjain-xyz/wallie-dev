import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

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

  it("delegates candidate selection to the concurrency-aware claim RPC", async () => {
    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    };

    const result = await pollOnce(admin as never, config);

    expect(result).toEqual({ jobId: null, outcome: "idle" });
    expect(admin.rpc).toHaveBeenCalledWith("claim_next_agent_job", {
      default_concurrency_limit: 2,
    });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("backs off when the claim RPC fails", async () => {
    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: null, error: { message: "rpc unavailable" } })),
    };

    const result = await pollOnce(admin as never, config);

    expect(result).toEqual({ jobId: null, outcome: "error" });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("claims and processes the first ready candidate", async () => {
    const claimedJob = { ...baseJob, status: "started" };
    const activeJobIds: Array<string | null> = [];
    mocked.processPipelineJob.mockResolvedValue(undefined);
    mocked.sendHeartbeat.mockResolvedValue(undefined);

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
    expect(admin.rpc).toHaveBeenCalledWith("claim_next_agent_job", {
      default_concurrency_limit: 2,
    });
    expect(mocked.processPipelineJob).toHaveBeenCalledWith({
      admin,
      job: claimedJob,
    });
    expect(mocked.sendHeartbeat).toHaveBeenCalledWith(admin, "worker-test", "job-1");
    expect(mocked.sendHeartbeat).toHaveBeenCalledWith(admin, "worker-test", null);
    expect(activeJobIds).toEqual(["job-1", null]);
  });

  it("clears active ownership when the first heartbeat fails", async () => {
    const claimedJob = { ...baseJob, status: "started" };
    const activeJobIds: Array<string | null> = [];
    const heartbeatError = new Error("heartbeat unavailable");
    mocked.processPipelineJob.mockResolvedValue(undefined);
    mocked.sendHeartbeat.mockRejectedValueOnce(heartbeatError).mockResolvedValueOnce(undefined);

    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: [claimedJob], error: null })),
    };

    await expect(
      pollOnce(admin as never, config, {
        setActiveJobId: (jobId) => activeJobIds.push(jobId),
      }),
    ).rejects.toThrow("heartbeat unavailable");

    expect(mocked.sendHeartbeat).toHaveBeenNthCalledWith(1, admin, "worker-test", "job-1");
    expect(mocked.sendHeartbeat).toHaveBeenNthCalledWith(2, admin, "worker-test", null);
    expect(activeJobIds).toEqual(["job-1", null]);
    expect(admin.from).not.toHaveBeenCalled();
    expect(mocked.processPipelineJob).not.toHaveBeenCalled();
  });

  it("defines next-job claiming with ready-job and workspace-capacity checks", () => {
    const migrationSql = readFileSync(
      "supabase/migrations/20260605000001_add_claim_next_agent_job.sql",
      "utf8",
    );

    expect(migrationSql).toContain("create or replace function public.claim_next_agent_job");
    expect(migrationSql).toContain("(scheduled_at is null or scheduled_at <= now())");
    expect(migrationSql).toContain("if running_count >= effective_limit then");
    expect(migrationSql).toContain("continue;");
    expect(migrationSql).toContain("for update skip locked");
    expect(migrationSql).toContain("pg_advisory_xact_lock");
    expect(migrationSql).toContain("hashtextextended(candidate.workspace_id::text, 0)");
  });

  it("keeps queued jobs unclaimed during Vercel connection mutations", () => {
    const migrationSql = readFileSync(
      "supabase/migrations/20260606000001_add_vercel_sandbox_connections.sql",
      "utf8",
    );

    expect(migrationSql).toContain(
      "create table public.workspace_vercel_sandbox_connection_mutations",
    );
    expect(migrationSql).toContain("create or replace function public.claim_next_agent_job");
    expect(migrationSql).toContain("pg_advisory_xact_lock");
    expect(migrationSql).toContain("from public.workspace_vercel_sandbox_connection_mutations");
    expect(migrationSql).toContain("where workspace_id = candidate.workspace_id");
  });
});
