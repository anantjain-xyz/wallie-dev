import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  processPipelineJob: vi.fn(),
  processFactoryWorkflowJoinJob: vi.fn().mockResolvedValue("ordinary"),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pipeline/processor", () => ({ processPipelineJob: mocked.processPipelineJob }));
vi.mock("@/lib/factory-workflows/join-worker-runtime", () => ({
  processFactoryWorkflowJoinJob: mocked.processFactoryWorkflowJoinJob,
}));
vi.mock("./heartbeat", () => ({ sendHeartbeat: mocked.sendHeartbeat }));
vi.mock("./loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loop")>()),
  claimNextJob: mocked.claimNextJob,
}));

import { parseWorkerConfig } from "./config";
import { createScheduler } from "./scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each(["pipeline", "join"] as const)(
  "retires a hung %s attempt and fills its scheduler slot",
  async (runner) => {
    vi.useFakeTimers();
    let shutdown = false;
    mocked.claimNextJob
      .mockResolvedValueOnce({ outcome: "claimed", job: { id: "hung-job", attempt_count: 1 } })
      .mockResolvedValueOnce({ outcome: "claimed", job: { id: "next-job", attempt_count: 1 } })
      .mockResolvedValue({ outcome: "idle" });
    if (runner === "join") {
      mocked.processFactoryWorkflowJoinJob.mockImplementationOnce(() => new Promise(() => {}));
    }
    mocked.processPipelineJob.mockImplementation(({ job }) => {
      if (job.id === "hung-job") return new Promise(() => {});
      shutdown = true;
      return Promise.resolve();
    });
    const query = {
      select: () => query,
      insert: () => query,
      eq: () => query,
      abortSignal: () => query,
      maybeSingle: async () => ({ data: { id: "hung-run" }, error: null }),
    };
    const admin = {
      from: () => query,
      rpc: vi.fn(() => ({ abortSignal: async () => ({ data: "error", error: null }) })),
    };
    const scheduler = createScheduler(
      admin as never,
      {
        ...parseWorkerConfig(),
        jobTimeoutMs: 50,
        maxConcurrentJobs: 1,
        pollIntervalMs: 10,
      },
      { isShuttingDown: () => shutdown },
    );
    const running = scheduler.run();
    await vi.advanceTimersByTimeAsync(49);
    expect(scheduler.getActiveJobIds()).toEqual(["hung-job"]);
    expect(mocked.processFactoryWorkflowJoinJob).toHaveBeenCalledOnce();
    expect(mocked.processPipelineJob).toHaveBeenCalledTimes(runner === "pipeline" ? 1 : 0);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    await scheduler.waitForIdle();
    expect(mocked.processFactoryWorkflowJoinJob).toHaveBeenCalledTimes(2);
    expect(mocked.processFactoryWorkflowJoinJob.mock.calls[0][0].signal.aborted).toBe(true);
    expect(mocked.processPipelineJob).toHaveBeenCalledTimes(runner === "pipeline" ? 2 : 1);
    expect(admin.rpc).toHaveBeenCalledExactlyOnceWith("fail_deadline_session_job_attempt", {
      p_job_id: "hung-job",
      p_attempt_count: 1,
      p_run_id: "hung-run",
      p_error: "Worker attempt exceeded its 50ms deadline.",
    });
    expect(scheduler.getActiveJobIds()).toEqual([]);
    expect(mocked.sendHeartbeat.mock.calls.at(-1)?.[2]).toEqual([]);
  },
);
