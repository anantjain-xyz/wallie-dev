import { describe, expect, it, vi } from "vitest";
import {
  dispatchWork,
  ensureWorkflow,
  recoverAttempt,
  type AttemptParams,
  type AuthParams,
  type JobDispatch,
  type WorkflowBinding,
} from "./dispatch";

function fixture() {
  const dispatch: JobDispatch = {
    job_id: "job",
    attempt_count: 2,
    workspace_id: "workspace",
    workflow_id: "job-job-2",
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    dispatched_at: null,
    execution_started_at: null,
  };
  let pending = [dispatch];
  const job = { status: "running", attempt_count: 2 };
  const changes: Array<{ table: string; kind: string; data?: unknown }> = [];
  const from = (table: string) => {
    let kind = "select";
    let values: unknown;
    const builder = {
      select: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: () => builder,
      update: (data: unknown) => {
        kind = "update";
        values = data;
        return builder;
      },
      delete: () => {
        kind = "delete";
        return builder;
      },
      maybeSingle: async () => ({ data: table === "agent_jobs" ? job : null, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        if (kind !== "select") {
          changes.push({ table, kind, data: values });
          if (table === "worker_dispatches" && kind === "update") {
            dispatch.dispatched_at = new Date().toISOString();
            pending = [];
          }
          if (table === "worker_dispatches" && kind === "delete") pending = [];
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        return Promise.resolve(
          resolve({ data: table === "worker_dispatches" ? pending : [], error: null }),
        );
      },
    };
    return builder;
  };
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const attempts: WorkflowBinding<AttemptParams> = {
    create: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ status: vi.fn().mockResolvedValue({ status: "running" }) }),
  };
  const auth: WorkflowBinding<AuthParams> = { create: vi.fn(), get: vi.fn() };
  return {
    admin: { from, rpc } as unknown as Parameters<typeof dispatchWork>[0],
    attempts,
    auth,
    changes,
    rpc,
    dispatch,
    job,
  };
}

describe("durable workflow dispatch", () => {
  it("allows sign-in dispatch while agent claims remain paused", async () => {
    const f = fixture();
    const from = vi.spyOn(f.admin, "from");
    await dispatchWork(f.admin, f, {
      maxConcurrent: 10,
      timeoutMs: 1_800_000,
      dispatchJobs: false,
    });
    expect(from).not.toHaveBeenCalledWith("worker_dispatches");
    expect(f.attempts.create).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("claim_next_worker_auth_dispatch");
  });
  it("resolves an ambiguous create using the same instance identity", async () => {
    const f = fixture();
    vi.mocked(f.attempts.create).mockRejectedValueOnce(new Error("ambiguous network timeout"));
    await ensureWorkflow(f.attempts, "job-job-2", {
      jobId: "job",
      attemptCount: 2,
      workflowId: "job-job-2",
    });
    expect(f.attempts.get).toHaveBeenCalledWith("job-job-2");
    expect(f.attempts.create).toHaveBeenCalledOnce();
  });

  it("leaves failed delivery pending and redelivers before claiming new work", async () => {
    const f = fixture();
    vi.mocked(f.attempts.create).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(f.attempts.get).mockRejectedValueOnce(new Error("not found"));
    expect(await dispatchWork(f.admin, f, { maxConcurrent: 1, timeoutMs: 1_800_000 })).toEqual({
      delivered: 0,
      failed: 1,
    });
    expect(f.changes).toEqual([]);
    expect(await dispatchWork(f.admin, f, { maxConcurrent: 1, timeoutMs: 1_800_000 })).toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(f.attempts.create).toHaveBeenNthCalledWith(2, {
      id: "job-job-2",
      params: { jobId: "job", attemptCount: 2, workflowId: "job-job-2" },
    });
    expect(f.changes).toEqual([
      expect.objectContaining({ table: "worker_dispatches", kind: "update" }),
    ]);
  });

  it("keeps an unknown Workflow pending after an ambiguous creation", async () => {
    const f = fixture();
    vi.mocked(f.attempts.create).mockRejectedValueOnce(new Error("ambiguous timeout"));
    vi.mocked(f.attempts.get).mockResolvedValueOnce({
      status: vi.fn().mockResolvedValue({ status: "unknown" }),
    });
    expect(await dispatchWork(f.admin, f, { maxConcurrent: 1, timeoutMs: 1_800_000 })).toEqual({
      delivered: 0,
      failed: 1,
    });
    expect(f.changes).toEqual([]);
  });

  it("discards superseded attempts without launching an agent or blocking the outbox", async () => {
    const f = fixture();
    f.job.attempt_count = 3;
    await dispatchWork(f.admin, f, { maxConcurrent: 1, timeoutMs: 1_800_000 });
    expect(f.attempts.create).not.toHaveBeenCalled();
    expect(f.changes).toEqual([{ table: "worker_dispatches", kind: "delete", data: undefined }]);
  });

  it("acknowledges an already-published exact run during recovery", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: "run", status: "success" }, error: null }),
    };
    await recoverAttempt({ from: () => query, rpc } as never, "job", 2, "interrupted");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("complete_session_job_attempt", {
      p_job_id: "job",
      p_attempt_count: 2,
      p_run_id: "run",
    });
  });
});
