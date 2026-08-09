import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  listRunningSandboxes: vi.fn().mockResolvedValue([]),
  loadWorkspaceSandboxConnection: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
  listRunningSandboxes: mocked.listRunningSandboxes,
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
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
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
}

interface AgentJobRow {
  id: string;
  session_id: string;
  attempt_count: number;
  last_error: string | null;
  status: "queued" | "running" | "success" | "error" | "canceled";
  updated_at: string;
  workspace_id: string;
}

interface AgentConfigRow {
  workspace_id: string;
  key: string;
  value_json: unknown;
}

interface WorkerHeartbeatRow {
  active_job_ids: string[];
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
  beforePublicationRecoveryCas?: () => void;
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
        range: async (from: number, to: number) => {
          const statuses = filters.get("status") as string[] | undefined;
          const workspaceId = filters.get("workspace_id") as string | undefined;
          return {
            data: state.runs
              .filter((r) => !statuses || statuses.includes(r.status))
              .filter((r) => !workspaceId || r.workspace_id === workspaceId)
              .slice(from, to + 1),
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
    select: () => {
      const equals = new Map<string, unknown>();
      const inclusions = new Map<string, unknown[]>();
      const prefixes = new Map<string, string>();
      const matchingRows = () =>
        state.jobs
          .filter((row) =>
            [...equals].every(([column, value]) =>
              Object.is(row[column as keyof AgentJobRow], value),
            ),
          )
          .filter((row) =>
            [...inclusions].every(([column, values]) =>
              values.includes(row[column as keyof AgentJobRow]),
            ),
          )
          .filter((row) =>
            [...prefixes].every(([column, prefix]) =>
              String(row[column as keyof AgentJobRow] ?? "").startsWith(prefix),
            ),
          );
      const builder = {
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          inclusions.set(column, values);
          return builder;
        },
        like: (column: string, pattern: string) => {
          prefixes.set(column, pattern.endsWith("%") ? pattern.slice(0, -1) : pattern);
          return builder;
        },
        maybeSingle: async () => ({ data: matchingRows()[0] ?? null, error: null }),
        order: () => builder,
        range: async (from: number, to: number) => ({
          data: matchingRows().slice(from, to + 1),
          error: null,
        }),
        then: (resolve: (value: { data: AgentJobRow[]; error: null }) => void) => {
          resolve({ data: matchingRows(), error: null });
        },
      };
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      const equals = new Map<string, unknown>();
      let executed = false;
      let matchedRows: AgentJobRow[] = [];
      const execute = () => {
        if (executed) return matchedRows;
        executed = true;
        if (equals.has("updated_at")) {
          state.beforePublicationRecoveryCas?.();
        }
        matchedRows = state.jobs.filter((row) =>
          [...equals].every(([column, value]) =>
            Object.is(row[column as keyof AgentJobRow], value),
          ),
        );
        for (const row of matchedRows) {
          const expectedStatus = equals.get("status");
          jobUpdates.push({
            id: row.id,
            patch,
            ...(typeof expectedStatus === "string" ? { status: expectedStatus } : {}),
          });
          Object.assign(row, patch);
        }
        return matchedRows;
      };
      const builder = {
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
        select: () => builder,
        then: (resolve: (value: { error: null }) => void) => {
          execute();
          resolve({ error: null });
        },
      };
      return builder;
    },
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
const PUBLICATION_CHECKPOINT =
  'Wallie pull request publication pending: {"artifactVersion":1,"pullRequestNumber":42,"reason":"Linear unavailable"}';

function activeRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    agent_job_id: "job-1",
    created_at: new Date(Date.now() - TEN_MIN_MS).toISOString(),
    last_activity_at: new Date(Date.now() - TEN_MIN_MS).toISOString(),
    status: "running",
    sandbox_id: "sandbox-1",
    sandbox_provider: "fake",
    sandbox_vercel_project_id: null,
    sandbox_vercel_team_id: null,
    ...overrides,
  };
}

function job(overrides: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    id: "job-1",
    session_id: "sess-1",
    attempt_count: 0,
    last_error: null,
    status: "running",
    updated_at: new Date(Date.now() - TEN_MIN_MS).toISOString(),
    workspace_id: "ws-1",
    ...overrides,
  };
}

beforeEach(() => {
  mocked.stopSandboxById.mockClear();
  mocked.listRunningSandboxes.mockClear();
  mocked.loadWorkspaceSandboxConnection.mockReset();
  mocked.loadWorkspaceSandboxConnection.mockResolvedValue(null);
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
        expected: "in_progress",
        id: "sess-1",
        patch: { phase_status: "rejected" },
      },
    ]);
  });

  it("stops Vercel-backed stalled sandboxes with workspace credentials", async () => {
    const credentials = { projectId: "prj_123", teamId: "team_123", token: "vca_secret" };
    mocked.loadWorkspaceSandboxConnection.mockResolvedValueOnce({
      connection: { credentials, provider: "vercel", revision: "revision-1" },
      preview: { workspaceId: "ws-1" },
    });
    const state: MockState = {
      configs: [],
      jobs: [job()],
      runs: [
        activeRun({
          sandbox_provider: "vercel",
          sandbox_vercel_project_id: "prj_123",
          sandbox_vercel_team_id: "team_123",
        }),
      ],
      rpcCalls: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
    };
    const { admin } = buildAdminMock(state);

    await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      connection: { credentials, provider: "vercel", revision: "revision-1" },
    });
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
        ["sess-1", { phase_status: "in_progress" }],
        ["sess-2", { phase_status: "in_progress" }],
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
      heartbeats: [{ active_job_ids: ["job-1"], last_heartbeat_at: new Date().toISOString() }],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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

  it("protects every concurrently in-flight job listed in a fresh heartbeat", async () => {
    const state: MockState = {
      runs: [
        activeRun({ id: "run-1", agent_job_id: "job-1" }),
        activeRun({ id: "run-2", agent_job_id: "job-2", sandbox_id: "sandbox-2" }),
      ],
      jobs: [job({ id: "job-1" }), job({ id: "job-2" })],
      configs: [],
      // A single worker reports multiple in-flight jobs.
      heartbeats: [
        { active_job_ids: ["job-1", "job-2"], last_heartbeat_at: new Date().toISOString() },
      ],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin, runUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual([]);
    expect(runUpdates).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("recovers a stalled publication-only job without losing its checkpoint", async () => {
    const state: MockState = {
      runs: [],
      jobs: [job({ last_error: PUBLICATION_CHECKPOINT })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin, jobUpdates, sessionUpdates } = buildAdminMock(state);

    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual([]);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(state.jobs[0]).toMatchObject({
      last_error: PUBLICATION_CHECKPOINT,
      status: "queued",
    });
    expect(jobUpdates).toEqual([
      {
        id: "job-1",
        patch: {
          finished_at: null,
          scheduled_at: expect.any(String),
          status: "queued",
        },
        status: "running",
      },
    ]);
    expect(state.rpcCalls).toEqual([]);
    expect(sessionUpdates).toEqual([
      {
        expected: "in_progress",
        id: "sess-1",
        patch: { phase_status: "rejected" },
      },
    ]);
  });

  it("does not recover or park a publication job that completed after the sweep snapshot", async () => {
    const state: MockState = {
      runs: [],
      jobs: [job({ last_error: PUBLICATION_CHECKPOINT })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    state.beforePublicationRecoveryCas = () => {
      Object.assign(state.jobs[0]!, {
        last_error: null,
        status: "success",
        updated_at: new Date().toISOString(),
      });
      state.sessions.get("sess-1")!.phase_status = "awaiting_review";
    };
    const { admin, jobUpdates, sessionUpdates } = buildAdminMock(state);

    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.retriedJobIds).toEqual([]);
    expect(result.stalledJobIds).toEqual([]);
    expect(jobUpdates).toEqual([]);
    expect(sessionUpdates).toEqual([]);
    expect(state.jobs[0]?.status).toBe("success");
    expect(state.sessions.get("sess-1")?.phase_status).toBe("awaiting_review");
  });

  it("does not recover a publication-only job owned by a live worker", async () => {
    const state: MockState = {
      runs: [],
      jobs: [job({ last_error: PUBLICATION_CHECKPOINT })],
      configs: [],
      heartbeats: [{ active_job_ids: ["job-1"], last_heartbeat_at: new Date().toISOString() }],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin, sessionUpdates } = buildAdminMock(state);

    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.retriedJobIds).toEqual([]);
    expect(state.jobs[0]?.status).toBe("running");
    expect(sessionUpdates).toEqual([]);
  });

  it("ignores malformed publication retry markers", async () => {
    const state: MockState = {
      runs: [],
      jobs: [job({ last_error: "Wallie pull request publication pending: not-json" })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);

    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.retriedJobIds).toEqual([]);
    expect(state.jobs[0]?.status).toBe("running");
  });

  it("does not stall a queued run before its job is claimed by a worker", async () => {
    const state: MockState = {
      runs: [activeRun({ status: "queued" })],
      jobs: [job({ status: "queued" })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual(["run-1"]);
    expect(result.retriedJobIds).toEqual(["job-1"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1");
  });

  it("scans past skipped queued runs to recover later stalled runs", async () => {
    const queuedRuns = Array.from({ length: 101 }, (_, index) =>
      activeRun({
        agent_job_id: `queued-job-${index}`,
        id: `queued-run-${index}`,
        sandbox_id: null,
        status: "queued",
      }),
    );
    const queuedJobs = queuedRuns.map((run, index) =>
      job({
        id: run.agent_job_id!,
        session_id: `queued-session-${index}`,
        status: "queued",
      }),
    );
    const state: MockState = {
      runs: [
        ...queuedRuns,
        activeRun({
          agent_job_id: "late-job",
          id: "late-run",
          sandbox_id: "late-sandbox",
          status: "running",
        }),
      ],
      jobs: [...queuedJobs, job({ id: "late-job", session_id: "late-session" })],
      configs: [],
      sessions: new Map([["late-session", { phase_status: "in_progress" }]]),
      rpcCalls: [],
    };
    const { admin, runUpdates } = buildAdminMock(state);
    const result = await sweepStalledRuns(admin as never, FIVE_MIN_MS);

    expect(result.stalledRunIds).toEqual(["late-run"]);
    expect(result.retriedJobIds).toEqual(["late-job"]);
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0].id).toBe("late-run");
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("late-sandbox");
  });

  it("marks a stalled run terminally errored when the job has no retries left", async () => {
    const state: MockState = {
      runs: [activeRun()],
      jobs: [job({ attempt_count: 3 })],
      configs: [],
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
    // session is wedged in 'in_progress'.
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
      sessions: new Map([["sess-1", { phase_status: "in_progress" }]]),
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
