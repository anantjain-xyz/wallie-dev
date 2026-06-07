import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { WorkerConfig } from "./config";

const mocked = vi.hoisted(() => ({
  processPipelineJob: vi.fn(),
}));

vi.mock("@/lib/pipeline/processor", () => ({
  processPipelineJob: mocked.processPipelineJob,
}));

import { claimNextJob, runClaimedJob } from "./loop";

const config: WorkerConfig = {
  defaultConcurrencyLimit: 2,
  defaultStallTimeoutMs: 900_000,
  heartbeatIntervalMs: 10_000,
  maxConcurrentJobs: 10,
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

describe("claimNextJob", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates candidate selection to the concurrency-aware claim RPC", async () => {
    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    };

    const result = await claimNextJob(admin as never, config);

    expect(result).toEqual({ outcome: "idle" });
    expect(admin.rpc).toHaveBeenCalledWith("claim_next_agent_job", {
      default_concurrency_limit: 2,
    });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("reports an error when the claim RPC fails", async () => {
    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: null, error: { message: "rpc unavailable" } })),
    };

    const result = await claimNextJob(admin as never, config);

    expect(result).toEqual({ outcome: "error" });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("returns the claimed job", async () => {
    const claimedJob = { ...baseJob, status: "running" };
    const admin = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: [claimedJob], error: null })),
    };

    const result = await claimNextJob(admin as never, config);

    expect(result).toEqual({ job: claimedJob, outcome: "claimed" });
  });
});

describe("runClaimedJob", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("touches run activity and processes the job", async () => {
    mocked.processPipelineJob.mockResolvedValue(undefined);

    const runStatusUpdate = { in: vi.fn(async () => ({ error: null })) };
    const runJobFilter = { eq: vi.fn(() => runStatusUpdate) };
    const runQuery = { update: vi.fn(() => runJobFilter) };
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "agent_runs") return runQuery;
        throw new Error(`unexpected table: ${table}`);
      }),
    };

    await runClaimedJob(admin as never, baseJob as never);

    expect(runQuery.update).toHaveBeenCalledWith({ last_activity_at: expect.any(String) });
    expect(runJobFilter.eq).toHaveBeenCalledWith("agent_job_id", "job-1");
    expect(mocked.processPipelineJob).toHaveBeenCalledWith({ admin, job: baseJob });
  });

  it("marks the job errored when the processor throws and never rejects", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("boom"));

    const runStatusUpdate = { in: vi.fn(async () => ({ error: null })) };
    const runJobFilter = { eq: vi.fn(() => runStatusUpdate) };
    const runQuery = { update: vi.fn(() => runJobFilter) };
    const jobErrorUpdate = { eq: vi.fn(async () => ({ error: null })) };
    const jobQuery = { update: vi.fn(() => jobErrorUpdate) };
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "agent_runs") return runQuery;
        if (table === "agent_jobs") return jobQuery;
        throw new Error(`unexpected table: ${table}`);
      }),
    };

    await expect(runClaimedJob(admin as never, baseJob as never)).resolves.toBeUndefined();

    expect(jobQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_error: "boom", status: "error" }),
    );
    expect(jobErrorUpdate.eq).toHaveBeenCalledWith("id", "job-1");
  });
});

describe("claim_next_agent_job migration", () => {
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
    expect(migrationSql).toContain(
      "expires_at timestamptz not null default now() + interval '15 minutes'",
    );
    expect(migrationSql).toContain("lock_id uuid not null default gen_random_uuid()");
    expect(migrationSql).toContain("return acquired_lock_id::text");
    expect(migrationSql).toContain(
      "delete from public.workspace_vercel_sandbox_connection_mutations",
    );
    expect(migrationSql).toContain("and expires_at > now()");
    expect(migrationSql).toContain("and checked_at > now() - interval '1 hour'");
    expect(migrationSql).toContain("create or replace function public.claim_next_agent_job");
    expect(migrationSql).toContain("pg_advisory_xact_lock");
    expect(migrationSql).toContain("from public.workspace_vercel_sandbox_connection_mutations");
    expect(migrationSql).toContain("where workspace_id = candidate.workspace_id");
  });
});
