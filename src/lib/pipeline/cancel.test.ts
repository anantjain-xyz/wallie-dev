import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
  stopSandboxById: vi.fn(async () => {}),
}));
vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: sandboxMocks.stopSandboxById,
}));

const connectionMocks = vi.hoisted(() => ({
  loadWorkspaceSandboxConnection: vi.fn(async () => null as unknown),
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: connectionMocks.loadWorkspaceSandboxConnection,
}));

import { cancelSessionWork, cancelWorkspaceWork, stopRunSandbox } from "@/lib/pipeline/cancel";

type ActiveRun = {
  id: string;
  sandbox_id: string | null;
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
  workspace_id: string;
};

interface Fixture {
  activeJobs?: { id: string }[];
  activeRuns?: ActiveRun[];
}

type Call = {
  filters: Record<string, unknown>;
  op: "insert" | "select" | "update";
  patch?: Record<string, unknown>;
  table: string;
};

function buildAdmin(fixture: Fixture) {
  const calls: Call[] = [];

  function makeBuilder(table: string, op: Call["op"], patch?: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        filters[`eq.${col}`] = val;
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters[`in.${col}`] = vals;
        return builder;
      },
      select() {
        return builder;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolveQuery().then(onFulfilled, onRejected);
      },
    };

    function resolveQuery(): Promise<{ data: unknown; error: null }> {
      calls.push({ filters, op, patch, table });

      if (op === "update" && table === "agent_jobs") {
        return Promise.resolve({
          data: (fixture.activeJobs ?? []).map((job) => ({ id: job.id })),
          error: null,
        });
      }
      // The runs cancel uses `.select(...)` to return the updated rows with
      // their sandbox refs — the source of truth for which sandboxes to stop.
      if (op === "update" && table === "agent_runs") {
        return Promise.resolve({ data: fixture.activeRuns ?? [], error: null });
      }
      // insert (messages) and sessions update both resolve to a plain success.
      return Promise.resolve({ data: [], error: null });
    }

    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        insert(patch: Record<string, unknown>) {
          return makeBuilder(table, "insert", patch);
        },
        select() {
          return makeBuilder(table, "select");
        },
        update(patch: Record<string, unknown>) {
          return makeBuilder(table, "update", patch);
        },
      };
    },
  };

  return { admin, calls };
}

function vercelRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    id: "run-1",
    sandbox_id: "sb-1",
    sandbox_provider: "vercel",
    sandbox_vercel_project_id: "proj-1",
    sandbox_vercel_team_id: "team-1",
    workspace_id: "w1",
    ...overrides,
  };
}

describe("cancelSessionWork", () => {
  afterEach(() => {
    vi.clearAllMocks();
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue(null as unknown);
  });

  it("cancels active jobs + runs, stops the sandbox, records a message, and parks the phase", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);
    const { admin, calls } = buildAdmin({
      activeJobs: [{ id: "job-1" }],
      activeRuns: [vercelRun()],
    });

    const result = await cancelSessionWork(admin as never, {
      reason: "Run canceled by a workspace member.",
      sessionId: "s1",
    });

    expect(result.canceledJobIds).toEqual(["job-1"]);
    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sb-1"]);

    const jobCancel = calls.find((c) => c.table === "agent_jobs" && c.op === "update");
    expect(jobCancel?.patch).toMatchObject({ status: "canceled" });
    expect(jobCancel?.filters["eq.session_id"]).toBe("s1");
    expect(jobCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);

    const runCancel = calls.find((c) => c.table === "agent_runs" && c.op === "update");
    expect(runCancel?.patch).toMatchObject({ status: "canceled" });
    expect(runCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);

    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledWith("sb-1", {
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    });

    const message = calls.find((c) => c.table === "agent_run_messages" && c.op === "insert");
    expect(message?.patch?.message_md).toContain("Canceled");
    expect(message?.patch?.agent_run_id).toBe("run-1");

    const sessionPark = calls.find((c) => c.table === "sessions" && c.op === "update");
    expect(sessionPark?.patch).toMatchObject({ phase_status: "rejected" });
    // Only un-stick a session that is still generating.
    expect(sessionPark?.filters["eq.phase_status"]).toBe("agent_generating");
  });

  it("leaves phase_status untouched when parkPhaseStatus is false", async () => {
    const { admin, calls } = buildAdmin({
      activeJobs: [{ id: "job-1" }],
      activeRuns: [vercelRun()],
    });

    await cancelSessionWork(admin as never, {
      parkPhaseStatus: false,
      reason: "Linear issue archived.",
      sessionId: "s1",
    });

    expect(calls.find((c) => c.table === "sessions" && c.op === "update")).toBeUndefined();
  });

  it("skips the sandbox stop for runs that never acquired one", async () => {
    const { admin } = buildAdmin({
      activeJobs: [{ id: "job-1" }],
      activeRuns: [vercelRun({ sandbox_id: null })],
    });

    const result = await cancelSessionWork(admin as never, {
      reason: "Run canceled by a workspace member.",
      sessionId: "s1",
    });

    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
    expect(result.stoppedSandboxIds).toEqual([]);
  });
});

describe("cancelWorkspaceWork", () => {
  afterEach(() => {
    vi.clearAllMocks();
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue(null as unknown);
  });

  it("cancels active jobs + runs scoped to the workspace and stops their sandboxes", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);
    const { admin, calls } = buildAdmin({
      activeJobs: [{ id: "job-1" }],
      activeRuns: [vercelRun()],
    });

    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });

    expect(result.canceledJobIds).toEqual(["job-1"]);
    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sb-1"]);

    const jobCancel = calls.find((c) => c.table === "agent_jobs" && c.op === "update");
    expect(jobCancel?.patch).toMatchObject({ status: "canceled" });
    expect(jobCancel?.filters["eq.workspace_id"]).toBe("w1");
    expect(jobCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);

    const runCancel = calls.find((c) => c.table === "agent_runs" && c.op === "update");
    expect(runCancel?.patch).toMatchObject({ status: "canceled" });
    expect(runCancel?.filters["eq.workspace_id"]).toBe("w1");
    expect(runCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);

    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledWith("sb-1", {
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    });

    // No per-run cancel message — those rows are about to be cascade-deleted.
    expect(calls.find((c) => c.table === "agent_run_messages")).toBeUndefined();
    // The workspace is being deleted; we do not touch session phase_status.
    expect(calls.find((c) => c.table === "sessions")).toBeUndefined();
  });

  it("flips a claimed run whose sandbox id has not landed yet without trying to stop it", async () => {
    // This is the race the snapshot alone could not close: the run is active but
    // sandbox_id is still null. Flipping it to `canceled` is what makes
    // updateRunSandbox refuse a late attach.
    const { admin } = buildAdmin({
      activeJobs: [{ id: "job-1" }],
      activeRuns: [vercelRun({ sandbox_id: null })],
    });

    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });

    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("is a no-op for a workspace with no active jobs or runs", async () => {
    const { admin } = buildAdmin({});

    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });

    expect(result).toEqual({ canceledJobIds: [], canceledRunIds: [], stoppedSandboxIds: [] });
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("stops sandboxes for every active run in the workspace, not just one", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);
    const { admin } = buildAdmin({
      activeRuns: [
        vercelRun({ id: "run-1", sandbox_id: "sb-1" }),
        vercelRun({ id: "run-2", sandbox_id: "sb-2" }),
      ],
    });

    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });

    expect(result.canceledRunIds).toEqual(["run-1", "run-2"]);
    expect(result.stoppedSandboxIds).toEqual(["sb-1", "sb-2"]);
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledTimes(2);
  });
});

describe("stopRunSandbox", () => {
  afterEach(() => {
    vi.clearAllMocks();
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue(null as unknown);
  });

  it("passes matching Vercel credentials when the run ran on the Vercel provider", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);

    await stopRunSandbox({} as never, vercelRun());

    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledWith("sb-1", {
      connection: {
        credentials: { projectId: "proj-1", teamId: "team-1", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    });
  });

  it("fails closed when the current connection does not match the run", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "other", teamId: "other", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);

    await stopRunSandbox({} as never, vercelRun());

    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("is a no-op when the run has no sandbox", async () => {
    await stopRunSandbox({} as never, vercelRun({ sandbox_id: null }));
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });
});
