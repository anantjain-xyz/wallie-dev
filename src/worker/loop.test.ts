import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => vi.clearAllMocks());

  function recoveryAdmin(runId: string | null = "run-attempt-1") {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({
        data: runId ? { id: runId } : null,
        error: null as { message: string } | null,
      })),
    };
    return {
      from: vi.fn(() => query),
      rpc: vi.fn(async () => ({ data: "error", error: null as { message: string } | null })),
      query,
    };
  }

  it("processes the claim without ownerless activity writes", async () => {
    mocked.processPipelineJob.mockResolvedValue(undefined);
    const admin = recoveryAdmin();
    await runClaimedJob(admin as never, baseJob as never);
    expect(mocked.processPipelineJob).toHaveBeenCalledWith({ admin, job: baseJob });
    expect(admin.from).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("recovers a thrown processor error through the exact owned run", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("boom"));
    const admin = recoveryAdmin();
    await expect(runClaimedJob(admin as never, baseJob as never)).resolves.toBeUndefined();
    expect(admin.query.eq.mock.calls).toEqual([
      ["agent_job_id", "job-1"],
      ["attempt_count", 1],
    ]);
    expect(admin.rpc).toHaveBeenCalledWith("fail_session_job_attempt", {
      p_job_id: "job-1",
      p_attempt_count: 1,
      p_run_id: "run-attempt-1",
      p_error: "boom",
      p_retry: false,
      p_max_retries: 0,
    });
  });

  it("uses runless recovery only when this attempt has no bound run", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("setup failed"));
    const admin = recoveryAdmin(null);
    await runClaimedJob(admin as never, baseJob as never);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_attempt_count: 1,
        p_run_id: undefined,
      }),
    );
  });

  it("keeps the captured attempt when processing is delayed past a newer claim", async () => {
    let reject!: (error: Error) => void;
    mocked.processPipelineJob.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const claim = { ...baseJob };
    const admin = recoveryAdmin();
    admin.rpc.mockResolvedValueOnce({ data: "stale", error: null });
    const processing = runClaimedJob(admin as never, claim as never);
    claim.attempt_count = 2;
    reject(new Error("old processor failed"));
    await processing;
    expect(admin.query.eq).toHaveBeenCalledWith("attempt_count", 1);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_attempt_count: 1 }),
    );
  });

  it("does not bypass an unavailable ownership RPC and never rejects the scheduler", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("boom"));
    const admin = recoveryAdmin();
    admin.rpc.mockResolvedValueOnce({ data: "", error: { message: "RPC unavailable" } });
    await expect(runClaimedJob(admin as never, baseJob as never)).resolves.toBeUndefined();
    expect(admin.from).toHaveBeenCalledTimes(1);
    expect(admin.from).toHaveBeenCalledWith("agent_runs");
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not treat a failed run lookup as proof of a runless attempt", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("boom"));
    const admin = recoveryAdmin();
    admin.query.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "read failed" },
    });
    await expect(runClaimedJob(admin as never, baseJob as never)).resolves.toBeUndefined();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("contains transport errors from the fallback itself", async () => {
    mocked.processPipelineJob.mockRejectedValue(new Error("boom"));
    const admin = recoveryAdmin();
    admin.rpc.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(runClaimedJob(admin as never, baseJob as never)).resolves.toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });
});
