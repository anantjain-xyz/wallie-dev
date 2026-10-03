import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ stopRunSandbox: vi.fn() }));
vi.mock("@/lib/pipeline/cancel", () => ({
  ACTIVE_AGENT_RUN_STATUSES: ["queued", "started", "running"],
  stopRunSandbox: mocked.stopRunSandbox,
}));

import { sweepStalledRuns } from "./stall-detector";

const TIMEOUT = 5 * 60_000;
const oldTime = () => new Date(Date.now() - 2 * TIMEOUT).toISOString();
const freshTime = () => new Date().toISOString();

type Run = ReturnType<typeof run>;
type Job = ReturnType<typeof job>;
type RpcArgs = {
  p_job_id: string;
  p_attempt_count: number;
  p_run_id?: string;
  p_error?: string;
  p_retry?: boolean;
  p_max_retries?: number;
};
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    agent_job_id: "job-1",
    attempt_count: 1 as number | null,
    workspace_id: "ws-1",
    created_at: oldTime(),
    last_activity_at: oldTime() as string | null,
    status: "running",
    sandbox_id: "sandbox-1" as string | null,
    sandbox_provider: "fake",
    sandbox_connection_revision: null as string | null,
    sandbox_vercel_project_id: null,
    sandbox_vercel_team_id: null,
    ...overrides,
  };
}
function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    attempt_count: 1,
    workspace_id: "ws-1",
    status: "running",
    created_at: oldTime(),
    started_at: oldTime() as string | null,
    ...overrides,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function buildAdmin(
  input: {
    runs?: Run[];
    jobs?: Job[];
    configs?: Array<{ workspace_id: string; key: string; value_json: unknown }>;
    heartbeatJobIds?: string[];
    failRead?: string;
    beforeRead?: (table: string) => Promise<void>;
    rpcError?: string;
    failOutcome?: string;
    beforeRpc?: (name: string, args: RpcArgs) => void;
  } = {},
) {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    agent_runs: input.runs ?? [run()],
    agent_jobs: input.jobs ?? [job()],
    workspace_agent_config: input.configs ?? [],
    worker_heartbeats: input.heartbeatJobIds?.length
      ? [{ active_job_ids: input.heartbeatJobIds, last_heartbeat_at: freshTime() }]
      : [],
  };
  const inserts: Array<Record<string, unknown>> = [];
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const admin = {
    from: vi.fn((table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table !== "agent_run_messages") throw new Error(`Unexpected write to ${table}`);
        inserts.push(row);
        return { error: null };
      },
      select: () => {
        const filters = new Map<string, unknown>();
        let range: [number, number] | undefined;
        const read = async () => {
          await input.beforeRead?.(table);
          reads.push({ table, filters: Object.fromEntries(filters) });
          if (input.failRead === table)
            return { data: null, error: { message: "read unavailable" } };
          const selected = (rows[table] ?? []).filter((row) =>
            [...filters].every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value,
            ),
          );
          return {
            data: (range ? selected.slice(range[0], range[1] + 1) : selected).map((row) => ({
              ...row,
            })),
            error: null,
          };
        };
        const query = {
          eq: (key: string, value: unknown) => {
            filters.set(key, value);
            return query;
          },
          in: (key: string, value: unknown) => {
            filters.set(key, value);
            return query;
          },
          gte: () => query,
          order: () => query,
          range: (from: number, to: number) => {
            range = [from, to];
            return query;
          },
          then: (resolve: (value: Awaited<ReturnType<typeof read>>) => void) =>
            read().then(resolve),
        };
        return query;
      },
    })),
    rpc: vi.fn(async (name: string, args: RpcArgs) => {
      input.beforeRpc?.(name, args);
      if (input.rpcError) return { data: null, error: { message: input.rpcError } };
      const current = rows.agent_jobs.find((row) => row.id === args.p_job_id);
      const currentRun = rows.agent_runs.find((row) => row.id === args.p_run_id);
      const owned =
        current?.attempt_count === args.p_attempt_count &&
        (args.p_run_id === undefined ||
          (currentRun?.attempt_count === args.p_attempt_count &&
            currentRun?.agent_job_id === args.p_job_id));
      if (name === "complete_session_job_attempt") return { data: owned, error: null };
      if (name !== "fail_session_job_attempt") throw new Error(`Unexpected RPC ${name}`);
      return { data: owned ? (input.failOutcome ?? "queued") : "stale", error: null };
    }),
  };
  return { admin, inserts, reads, rows };
}

beforeEach(() => mocked.stopRunSandbox.mockReset().mockResolvedValue(true));

describe("sweepStalledRuns ownership recovery", () => {
  it("leaves recent activity alone", async () => {
    const { admin } = buildAdmin({ runs: [run({ last_activity_at: freshTime() })] });
    expect((await sweepStalledRuns(admin as never, TIMEOUT)).stalledRunIds).toEqual([]);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("resolves the exact stalled attempt before stopping its captured sandbox", async () => {
    const { admin, inserts } = buildAdmin();
    mocked.stopRunSandbox.mockImplementationOnce(async () => {
      expect(admin.rpc).toHaveBeenCalledWith("fail_session_job_attempt", {
        p_job_id: "job-1",
        p_attempt_count: 1,
        p_run_id: "run-1",
        p_error: expect.stringContaining("Stalled: no activity"),
        p_retry: true,
        p_max_retries: 3,
      });
      return true;
    });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(result).toEqual({
      stalledRunIds: ["run-1"],
      stalledJobIds: [],
      stoppedSandboxIds: ["sandbox-1"],
      retriedJobIds: ["job-1"],
    });
    expect(inserts).toEqual([
      {
        agent_run_id: "run-1",
        kind: "error",
        message_md: expect.stringContaining("Stalled: no activity"),
        workspace_id: "ws-1",
      },
    ]);
    expect(mocked.stopRunSandbox).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ id: "run-1", sandbox_id: "sandbox-1" }),
      expect.any(Map),
    );
  });

  it("does not report a stopped sandbox when cleanup is skipped", async () => {
    const { admin } = buildAdmin();
    mocked.stopRunSandbox.mockResolvedValueOnce(false);

    const result = await sweepStalledRuns(admin as never, TIMEOUT);

    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopRunSandbox).toHaveBeenCalledOnce();
  });

  it("passes persisted provider connection identity to sandbox cleanup", async () => {
    const ownedRun = run({
      sandbox_provider: "vercel",
      sandbox_connection_revision: "revision-old",
    });
    const { admin } = buildAdmin({ runs: [ownedRun] });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(mocked.stopRunSandbox).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        sandbox_provider: "vercel",
        sandbox_connection_revision: "revision-old",
      }),
      expect.any(Map),
    );
  });

  it("records terminal exhaustion only when the RPC confirms it", async () => {
    const { admin } = buildAdmin({
      jobs: [job({ attempt_count: 3 })],
      runs: [run({ attempt_count: 3 })],
      failOutcome: "error",
    });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(result.stalledJobIds).toEqual(["job-1"]);
    expect(result.retriedJobIds).toEqual([]);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_attempt_count: 3, p_max_retries: 3 }),
    );
  });

  it("uses workspace stall timeout and retry cap", async () => {
    const { admin } = buildAdmin({
      runs: [run({ last_activity_at: new Date(Date.now() - 60_000).toISOString() })],
      configs: [
        { workspace_id: "ws-1", key: "stall_timeout_ms", value_json: 30_000 },
        { workspace_id: "ws-1", key: "max_retries", value_json: 0 },
      ],
      failOutcome: "error",
    });
    expect((await sweepStalledRuns(admin as never, TIMEOUT)).stalledJobIds).toEqual(["job-1"]);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_max_retries: 0 }),
    );
  });

  it("uses created_at when legacy last_activity_at is absent", async () => {
    const { admin } = buildAdmin({ runs: [run({ last_activity_at: null, sandbox_id: null })] });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
  });

  it("does not treat an invalid activity timestamp as a stalled run", async () => {
    const { admin } = buildAdmin({ runs: [run({ last_activity_at: "invalid" })] });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("does not fall back to direct writes or stop a sandbox when the RPC fails", async () => {
    const { admin, inserts } = buildAdmin({ rpcError: "RPC unavailable" });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(result).toEqual({
      stalledRunIds: [],
      stalledJobIds: [],
      stoppedSandboxIds: [],
      retriedJobIds: [],
    });
    expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(admin.from).not.toHaveBeenCalledWith("sessions");
  });

  it("ignores stale RPC outcomes without writing an error message or stopping a sandbox", async () => {
    const { admin, inserts } = buildAdmin({ failOutcome: "stale" });
    expect((await sweepStalledRuns(admin as never, TIMEOUT)).stalledRunIds).toEqual([]);
    expect(inserts).toEqual([]);
    expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
  });

  it("leaves PR sandbox work alone when publication wins after the active-run snapshot", async () => {
    const publishingRun = run();
    const { admin, inserts } = buildAdmin({
      runs: [publishingRun],
      failOutcome: "success",
      beforeRpc: () => {
        publishingRun.status = "success";
      },
    });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_job_id: "job-1",
        p_attempt_count: 1,
        p_run_id: "run-1",
      }),
    );
    expect(publishingRun.status).toBe("success");
    expect(result).toEqual({
      stalledRunIds: [],
      stalledJobIds: [],
      retriedJobIds: [],
      stoppedSandboxIds: [],
    });
    expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("protects every job named by a fresh worker heartbeat", async () => {
    const { admin } = buildAdmin({
      jobs: [job(), job({ id: "job-2" })],
      runs: [run(), run({ id: "run-2", agent_job_id: "job-2" })],
      heartbeatJobIds: ["job-1", "job-2"],
    });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("does not touch a queued job even if its placeholder is old", async () => {
    const { admin } = buildAdmin({
      jobs: [job({ status: "queued" })],
      runs: [run({ status: "queued", attempt_count: null })],
    });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { runs: [] },
    { runs: [run({ status: "queued", attempt_count: null })] },
    { runs: [run({ status: "success", attempt_count: 1 })] },
  ])(
    "allows a fresh claim to start before recovering its missing owned run (%j)",
    async ({ runs }) => {
      const { admin } = buildAdmin({
        jobs: [job({ attempt_count: 2, started_at: freshTime() })],
        runs,
      });
      await sweepStalledRuns(admin as never, TIMEOUT);
      expect(admin.rpc).not.toHaveBeenCalled();
    },
  );

  it("recovers an aged claim with no bound run using its captured attempt", async () => {
    const { admin } = buildAdmin({
      jobs: [job({ attempt_count: 2 })],
      runs: [run({ attempt_count: 1, status: "success" })],
    });
    const result = await sweepStalledRuns(admin as never, TIMEOUT);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_attempt_count: 2, p_run_id: undefined }),
    );
    expect(admin.rpc).not.toHaveBeenCalledWith("complete_session_job_attempt", expect.anything());
    expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
  });

  it("recovers an aged pre-start placeholder without inventing run ownership", async () => {
    const { admin } = buildAdmin({
      runs: [run({ attempt_count: null, status: "queued", sandbox_id: null })],
    });
    expect((await sweepStalledRuns(admin as never, TIMEOUT)).stalledRunIds).toEqual(["run-1"]);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_attempt_count: 1, p_run_id: undefined }),
    );
  });

  it.each(["started", "running"])(
    "completes a %s job only with the successful run for its current attempt",
    async (status) => {
      const { admin, inserts } = buildAdmin({
        jobs: [job({ status, attempt_count: 2 })],
        runs: [
          run({ id: "old-run", attempt_count: 1, status: "success" }),
          run({ attempt_count: 2, status: "success" }),
        ],
      });
      const result = await sweepStalledRuns(admin as never, TIMEOUT);
      expect(admin.rpc.mock.calls).toEqual([
        [
          "complete_session_job_attempt",
          { p_job_id: "job-1", p_attempt_count: 2, p_run_id: "run-1" },
        ],
      ]);
      expect(result.retriedJobIds).toEqual([]);
      expect(inserts).toEqual([]);
    },
  );

  it("never adopts a legacy successful run as completion evidence", async () => {
    const { admin } = buildAdmin({ runs: [run({ attempt_count: null, status: "success" })] });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_run_id: undefined }),
    );
    expect(admin.rpc).not.toHaveBeenCalledWith("complete_session_job_attempt", expect.anything());
  });

  it("leaves atomically resolved owned terminal failures alone", async () => {
    const { admin } = buildAdmin({ runs: [run({ status: "error" })] });
    await sweepStalledRuns(admin as never, TIMEOUT);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each(["agent_runs", "agent_jobs", "worker_heartbeats"])(
    "fails closed when %s cannot be read",
    async (failRead) => {
      const { admin } = buildAdmin({ failRead });
      await sweepStalledRuns(admin as never, TIMEOUT);
      expect(admin.rpc).not.toHaveBeenCalled();
      expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
    },
  );

  it("limits job recovery to the requested workspace", async () => {
    const { admin } = buildAdmin({
      jobs: [job(), job({ id: "job-2", workspace_id: "ws-2" })],
      runs: [run(), run({ id: "run-2", agent_job_id: "job-2", workspace_id: "ws-2" })],
    });
    expect(
      (await sweepStalledRuns(admin as never, TIMEOUT, { workspaceId: "ws-1" })).stalledRunIds,
    ).toEqual(["run-1"]);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it("paginates claimed jobs and their runs beyond the first batch", async () => {
    const jobs = Array.from({ length: 101 }, (_, i) => job({ id: `job-${i}` }));
    const runs = jobs.map((entry, i) =>
      run({
        id: `run-${i}`,
        agent_job_id: entry.id,
        last_activity_at: i === 100 ? oldTime() : freshTime(),
      }),
    );
    const { admin } = buildAdmin({ jobs, runs });
    expect((await sweepStalledRuns(admin as never, TIMEOUT)).stalledRunIds).toEqual(["run-100"]);
  });

  it("never switches to a replacement attempt after waiting for sandbox shutdown", async () => {
    const stopStarted = deferred();
    const finishStop = deferred();
    const { admin, rows } = buildAdmin();
    mocked.stopRunSandbox.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await finishStop.promise;
      return true;
    });
    const sweep = sweepStalledRuns(admin as never, TIMEOUT);
    await stopStarted.promise;
    rows.agent_jobs[0].attempt_count = 2;
    rows.agent_runs.push(
      run({
        id: "run-2",
        attempt_count: 2,
        sandbox_id: "sandbox-2",
        last_activity_at: freshTime(),
      }),
    );
    finishStop.resolve();
    const result = await sweep;
    expect(result.stoppedSandboxIds).toEqual(["sandbox-1"]);
    expect(admin.rpc.mock.calls).toHaveLength(1);
    expect(admin.rpc.mock.calls[0][1]).toMatchObject({ p_attempt_count: 1, p_run_id: "run-1" });
    expect(rows.agent_jobs[0].attempt_count).toBe(2);
    expect(rows.agent_runs[1]).toMatchObject({ status: "running", sandbox_id: "sandbox-2" });
  });

  it("does not recover a replacement claim while an earlier job's sandbox stop is pending", async () => {
    const stopStarted = deferred();
    const finishStop = deferred();
    const { admin, rows } = buildAdmin({
      jobs: [job(), job({ id: "job-2" })],
      runs: [run(), run({ id: "old-run-2", agent_job_id: "job-2", sandbox_id: "old-sandbox-2" })],
    });
    mocked.stopRunSandbox.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await finishStop.promise;
      return true;
    });
    const sweep = sweepStalledRuns(admin as never, TIMEOUT);
    await stopStarted.promise;
    rows.agent_jobs[1].attempt_count = 2;
    rows.agent_runs[1].status = "error";
    rows.agent_runs.push(
      run({
        id: "new-run-2",
        agent_job_id: "job-2",
        attempt_count: 2,
        sandbox_id: "new-sandbox-2",
        last_activity_at: freshTime(),
      }),
    );
    finishStop.resolve();
    const result = await sweep;
    expect(admin.rpc).toHaveBeenLastCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_job_id: "job-2",
        p_attempt_count: 1,
        p_run_id: "old-run-2",
      }),
    );
    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sandbox-1"]);
    expect(mocked.stopRunSandbox).toHaveBeenCalledTimes(1);
    expect(rows.agent_runs[2]).toMatchObject({ status: "running", attempt_count: 2 });
  });

  it("keeps the original job claim when a run lookup waits past a replacement claim", async () => {
    const readStarted = deferred();
    const finishRead = deferred();
    const { admin, rows } = buildAdmin({
      beforeRead: async (table) => {
        if (table === "agent_runs") {
          readStarted.resolve();
          await finishRead.promise;
        }
      },
    });
    const sweep = sweepStalledRuns(admin as never, TIMEOUT);
    await readStarted.promise;
    rows.agent_jobs[0].attempt_count = 2;
    rows.agent_runs.push(run({ id: "run-2", attempt_count: 2, sandbox_id: "sandbox-2" }));
    finishRead.resolve();
    const result = await sweep;
    expect(admin.rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_attempt_count: 1, p_run_id: "run-1" }),
    );
    expect(result.stalledRunIds).toEqual([]);
    expect(mocked.stopRunSandbox).not.toHaveBeenCalled();
  });
});
