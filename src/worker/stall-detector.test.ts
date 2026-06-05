import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  listRunningSandboxes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
  listRunningSandboxes: mocked.listRunningSandboxes,
}));

import { sweepStalledRuns } from "./stall-detector";

// ---- supabase mock ------------------------------------------------------

interface AgentRunRow {
  id: string;
  workspace_id: string;
  agent_job_id: string | null;
  last_activity_at: string | null;
  created_at: string;
  status: "queued" | "started" | "running" | "success" | "error" | "canceled";
  sandbox_id: string | null;
}

interface AgentJobRow {
  id: string;
  session_id: string;
  attempt_count: number;
  status: "queued" | "running" | "success" | "error" | "canceled";
}

interface AgentConfigRow {
  workspace_id: string;
  key: string;
  value_json: unknown;
}

interface WorkerHeartbeatRow {
  active_job_id: string | null;
  last_heartbeat_at: string;
}

interface AgentRunMessageInsert {
  agent_run_id: string;
  kind: string;
  message_md: string;
  workspace_id: string;
}

interface MockState {
  runs: AgentRunRow[];
  jobs: AgentJobRow[];
  configs: AgentConfigRow[];
  heartbeats?: WorkerHeartbeatRow[];
  sessions: Map<string, { phase_status: string }>;
  rpcCalls: Array<{ name: string; args: unknown }>;
  retryRpcShouldFail?: boolean;
}

function buildAdminMock(state: MockState) {
  const runUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const jobUpdates: Array<{ id: string; patch: Record<string, unknown>; status?: string }> = [];
  const runMessageInserts: AgentRunMessageInsert[] = [];
  const sessionUpdates: Array<{ id: string; patch: Record<string, unknown>; expected?: string }> =
    [];

  const fromAgentRuns = () => ({
    select: () => {
      const filters = new Map<string, unknown>();
      const builder = {
        eq: (col: string, value: unknown) => {
          filters.set(col, value);
          return builder;
        },
        in: (col: string, value: unknown) => {
          filters.set(col, value);
          return builder;
        },
        order: () => builder,
        limit: async () => {
          const statuses = filters.get("status") as string[] | undefined;
          const workspaceId = filters.get("workspace_id") as string | undefined;
          return {
            data: state.runs
              .filter((r) => !statuses || statuses.includes(r.status))
              .filter((r) => !workspaceId || r.workspace_id === workspaceId),
            error: null,
          };
        },
      };
      return builder;
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (_col: string, runId: string) => ({
        in: async () => {
          runUpdates.push({ id: runId, patch });
          const row = state.runs.find((r) => r.id === runId);
          if (row && ["queued", "started", "running"].includes(row.status)) {
            Object.assign(row, patch);
          }
          return { error: null };
        },
      }),
    }),
  });

  const fromAgentJobs = () => ({
    select: (cols: string) => ({
      eq: (_col: string, id: string) => ({
        maybeSingle: async () => {
          const row = state.jobs.find((j) => j.id === id);
          if (!row) return { data: null, error: null };
          if (cols.includes("session_id")) {
            return { data: { session_id: row.session_id }, error: null };
          }
          if (cols.includes("attempt_count")) {
            return { data: { attempt_count: row.attempt_count }, error: null };
          }
          return { data: row, error: null };
        },
      }),
      in: (_col: string, ids: string[]) => ({
        eq: async (_col2: string, expectedStatus: string) => ({
          data: state.jobs
            .filter((row) => ids.includes(row.id) && row.status === expectedStatus)
            .map((row) => ({ id: row.id })),
          error: null,
        }),
      }),
    }),
    update: (patch: Record<string, unknown>) => ({
      // Stall-detector calls update(...).eq("id", jobId) (single-eq, awaited)
      // for the retry-path last_error stamp, and update(...).eq("id", jobId)
      // .eq("status", "running") (chained, awaited) for the terminal path.
      // The returned thenable resolves immediately for the single-eq case;
      // the chained .eq filters by status before applying.
      eq: (_col: string, jobId: string) => {
        let recorded = false;
        const recordSingle = () => {
          if (recorded) return;
          recorded = true;
          jobUpdates.push({ id: jobId, patch });
          const row = state.jobs.find((j) => j.id === jobId);
          if (row) Object.assign(row, patch);
        };
        const thenable = {
          // The chained `.eq("status", "running")` path. Skip the single-
          // record so we don't double-count.
          eq: async (_col2: string, expectedStatus: string) => {
            recorded = true;
            jobUpdates.push({ id: jobId, patch, status: expectedStatus });
            const row = state.jobs.find((j) => j.id === jobId);
            if (row && row.status === expectedStatus) Object.assign(row, patch);
            return { error: null };
          },
          then: (resolve: (v: { error: null }) => void) => {
            recordSingle();
            resolve({ error: null });
          },
        };
        return thenable;
      },
    }),
  });

  const fromConfig = () => ({
    select: () => ({
      in: (_col: string, workspaceIds: string[]) => ({
        eq: async (_col2: string, key: string) => ({
          data: state.configs.filter((c) => workspaceIds.includes(c.workspace_id) && c.key === key),
          error: null,
        }),
      }),
    }),
  });

  const fromWorkerHeartbeats = () => ({
    select: () => ({
      gte: async (_col: string, cutoff: string) => ({
        data: (state.heartbeats ?? []).filter(
          (heartbeat) =>
            new Date(heartbeat.last_heartbeat_at).getTime() >= new Date(cutoff).getTime(),
        ),
        error: null,
      }),
    }),
  });

  const fromAgentRunMessages = () => ({
    insert: async (row: AgentRunMessageInsert) => {
      runMessageInserts.push(row);
      return { error: null };
    },
  });

  const fromSessions = () => ({
    update: (patch: Record<string, unknown>) => ({
      eq: (_col: string, sessionId: string) => ({
        eq: async (_col2: string, expected: string) => {
          sessionUpdates.push({ id: sessionId, patch, expected });
          const row = state.sessions.get(sessionId);
          if (row && row.phase_status === expected) {
            Object.assign(row, patch);
          }
          return { error: null };
        },
      }),
    }),
  });

  const tables: Record<string, unknown> = {
    agent_runs: fromAgentRuns(),
    agent_jobs: fromAgentJobs(),
    agent_run_messages: fromAgentRunMessages(),
    workspace_agent_config: fromConfig(),
    worker_heartbeats: fromWorkerHeartbeats(),
    sessions: fromSessions(),
  };

  return {
    admin: {
      from: (name: string) => tables[name] ?? {},
      rpc: vi.fn(async (name: string, args: unknown) => {
        state.rpcCalls.push({ name, args });
        if (name === "schedule_job_retry" && state.retryRpcShouldFail) {
          return { data: null, error: { message: "rpc failure" } };
        }
        // Successful retry: re-queue + bump attempt_count.
        if (name === "schedule_job_retry") {
          const a = args as { target_job_id: string };
          const row = state.jobs.find((j) => j.id === a.target_job_id);
          if (row) {
            row.status = "queued";
            row.attempt_count += 1;
          }
        }
        return { data: null, error: null };
      }),
    },
    runUpdates,
    jobUpdates,
    runMessageInserts,
    sessionUpdates,
  };
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

function activeRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    agent_job_id: "job-1",
    created_at: new Date(Date.now() - TEN_MIN_MS).toISOString(),
    last_activity_at: new Date(Date.now() - TEN_MIN_MS).toISOString(),
    status: "running",
    sandbox_id: "sandbox-1",
    ...overrides,
  };
}

function job(overrides: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    id: "job-1",
    session_id: "sess-1",
    attempt_count: 0,
    status: "running",
    ...overrides,
  };
}

beforeEach(() => {
  mocked.stopSandboxById.mockClear();
  mocked.listRunningSandboxes.mockClear();
});

describe("sweepStalledRuns", () => {
  it("ignores runs whose last activity is within the timeout", async () => {
    const state: MockState = {
      runs: [
        activeRun({
          last_activity_at: new Date(Date.now() - 30 * 1000).toISOString(),
        }),
      ],
      jobs: [job()],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin, runUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);
    expect(result.stalledRunIds).toEqual([]);
    expect(runUpdates).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("marks a stalled run errored, stops its sandbox, retries the job, and unblocks the session", async () => {
    const state: MockState = {
      runs: [activeRun()],
      jobs: [job()],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin, runMessageInserts, runUpdates, sessionUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sandbox-1"]);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(result.stalledJobIds).toEqual([]);

    // Run row was patched to error.
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0].patch.status).toBe("error");
    expect(runMessageInserts).toEqual([
      {
        agent_run_id: "run-1",
        kind: "error",
        message_md: expect.stringContaining("Stalled: no activity"),
        workspace_id: "ws-1",
      },
    ]);

    // Sandbox stop call.
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1");

    expect(state.rpcCalls).toContainEqual({
      args: {
        base_delay_ms: 5000,
        max_backoff_ms: 300000,
        target_job_id: "job-1",
      },
      name: "schedule_job_retry",
    });

    expect(sessionUpdates).toEqual([
      {
        expected: "agent_generating",
        id: "sess-1",
        patch: { phase_status: "rejected" },
      },
    ]);
  });

  it("only sweeps stalled runs in the requested workspace", async () => {
    const state: MockState = {
      configs: [],
      jobs: [
        job({ id: "job-1", session_id: "sess-1" }),
        job({ id: "job-2", session_id: "sess-2" }),
      ],
      runs: [
        activeRun({ id: "run-1", workspace_id: "ws-1", agent_job_id: "job-1" }),
        activeRun({
          id: "run-2",
          workspace_id: "ws-2",
          agent_job_id: "job-2",
          sandbox_id: "sandbox-2",
        }),
      ],
      rpcCalls: [],
      sessions: new Map([
        ["sess-1", { phase_status: "agent_generating" }],
        ["sess-2", { phase_status: "agent_generating" }],
      ]),
    };
    const { admin } = buildAdminMock(state);

    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS, { workspaceId: "ws-1" });

    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sandbox-1"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1");
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith("sandbox-2");
    expect(state.runs.find((run) => run.id === "run-1")?.status).toBe("error");
    expect(state.runs.find((run) => run.id === "run-2")?.status).toBe("running");
  });

  it("does not kill a stale run when a fresh worker heartbeat owns the job", async () => {
    const state: MockState = {
      runs: [activeRun()],
      jobs: [job()],
      configs: [],
      heartbeats: [{ active_job_id: "job-1", last_heartbeat_at: new Date().toISOString() }],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin, runUpdates, sessionUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual([]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(runUpdates).toEqual([]);
    expect(sessionUpdates).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does not stall a queued run before its job is claimed by a worker", async () => {
    const state: MockState = {
      runs: [activeRun({ status: "queued" })],
      jobs: [job({ status: "queued" })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin, runMessageInserts, runUpdates, sessionUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual([]);
    expect(result.stalledJobIds).toEqual([]);
    expect(result.retriedJobIds).toEqual([]);
    expect(runUpdates).toEqual([]);
    expect(runMessageInserts).toEqual([]);
    expect(sessionUpdates).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("can still recover a queued run once its job has been claimed", async () => {
    const state: MockState = {
      runs: [activeRun({ status: "queued" })],
      jobs: [job({ status: "running" })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1");
  });

  it("marks a stalled run terminally errored when the job has no retries left", async () => {
    const state: MockState = {
      runs: [activeRun()],
      jobs: [job({ attempt_count: 3 })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin, jobUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.retriedJobIds).toEqual([]);
    expect(result.stalledJobIds).toEqual(["job-1"]);

    // schedule_job_retry should NOT have been called.
    expect(state.rpcCalls.some((c) => c.name === "schedule_job_retry")).toBe(false);

    expect(jobUpdates).toContainEqual({
      id: "job-1",
      patch: {
        finished_at: expect.any(String),
        last_error: expect.stringContaining("Stalled: no activity"),
        status: "error",
      },
      status: "running",
    });
  });

  it("respects the per-workspace stall_timeout_ms override", async () => {
    // Default timeout is 1 hour, but workspace overrides to 1 minute.
    const state: MockState = {
      runs: [
        activeRun({
          last_activity_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        }),
      ],
      jobs: [job()],
      configs: [{ workspace_id: "ws-1", key: "stall_timeout_ms", value_json: 60_000 }],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, 60 * 60 * 1000);
    expect(result.stalledRunIds).toEqual(["run-1"]);
  });

  it("falls back to terminal error if schedule_job_retry RPC fails", async () => {
    const state: MockState = {
      runs: [activeRun()],
      jobs: [job()],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
      retryRpcShouldFail: true,
    };
    const { admin } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);
    expect(result.retriedJobIds).toEqual([]);
    expect(result.stalledJobIds).toEqual(["job-1"]);
  });

  it("handles a stalled run with no sandbox_id (legacy row) without crashing", async () => {
    const state: MockState = {
      runs: [activeRun({ sandbox_id: null })],
      jobs: [job()],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);
    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("simulates a worker crash mid-stage and reaches a clean terminal state on the next sweep tick", async () => {
    // Emulates the WAL-9 scenario: processor created the sandbox, inserted
    // an agent_runs row in 'running', and the JS process was killed before
    // its `finally` could call sandbox.stop(). Operationally the sandbox is
    // still alive in the provider, the run is stuck in 'running', and the
    // session is wedged in 'agent_generating'.
    const state: MockState = {
      runs: [
        activeRun({
          id: "run-crash",
          sandbox_id: "sandbox-crash",
          last_activity_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        }),
      ],
      jobs: [job({ id: "job-1", attempt_count: 0 })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "agent_generating" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);

    await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    // Run is errored, sandbox is stopped, job is rescheduled, session is unwedged.
    const run = state.runs.find((r) => r.id === "run-crash")!;
    expect(run.status).toBe("error");
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-crash");
    expect(state.rpcCalls).toContainEqual({
      args: {
        base_delay_ms: 5000,
        max_backoff_ms: 300000,
        target_job_id: "job-1",
      },
      name: "schedule_job_retry",
    });
    expect(state.sessions.get("sess-1")?.phase_status).toBe("rejected");

    // A second sweep tick is a no-op — no active rows remain.
    const second = await sweepStalledRuns(admin as never, FIVE_MIN_MS);
    expect(second.stalledRunIds).toEqual([]);
  });
});
