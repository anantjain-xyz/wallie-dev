import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
  stopSandboxById: vi.fn(async () => {}),
}));
vi.mock("@/lib/sandbox", () => ({ stopSandboxById: sandboxMocks.stopSandboxById }));
const connectionMocks = vi.hoisted(() => ({
  loadWorkspaceSandboxConnection: vi.fn(async () => null as unknown),
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: connectionMocks.loadWorkspaceSandboxConnection,
}));

import {
  cancelSessionWork,
  cancelWorkspaceWork,
  stopRunSandbox,
  type SessionWorkReceipt,
} from "@/lib/pipeline/cancel";

type Run = {
  id: string;
  status: "canceled" | "success" | "running";
  sandbox_id: string | null;
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
  workspace_id: string;
};
type Call = {
  filters: Record<string, unknown>;
  op: "insert" | "select";
  patch?: Record<string, unknown>;
  table: string;
};

function buildAdmin(
  fixture: {
    receipt?: SessionWorkReceipt;
    runs?: Run[];
    sessions?: { id: string }[];
    queryError?: string;
  } = {},
) {
  const calls: Call[] = [];
  const rpc = vi.fn(async () => ({
    data: [fixture.receipt ?? { job_ids: [], run_ids: [] }],
    error: null as { message: string } | null,
  }));
  const admin = {
    rpc,
    from(table: string) {
      function builder(op: Call["op"], patch?: Record<string, unknown>) {
        const filters: Record<string, unknown> = {};
        const query = {
          eq(column: string, value: unknown) {
            filters[`eq.${column}`] = value;
            return query;
          },
          gt(column: string, value: string) {
            filters[`gt.${column}`] = value;
            return query;
          },
          order(column: string) {
            filters.order = column;
            return query;
          },
          limit(value: number) {
            filters.limit = value;
            return query;
          },
          in(column: string, value: string[]) {
            filters[`in.${column}`] = value;
            return query;
          },
          then(resolve: (result: { data: unknown; error: { message: string } | null }) => unknown) {
            calls.push({ filters, op, patch, table });
            let data: unknown = [];
            if (table === "sessions") {
              data = (fixture.sessions ?? [])
                .filter((session) => !filters["gt.id"] || session.id > (filters["gt.id"] as string))
                .slice(0, filters.limit as number | undefined);
            }
            if (table === "agent_runs") {
              data = (fixture.runs ?? []).filter(
                (run) =>
                  run.workspace_id === filters["eq.workspace_id"] &&
                  (filters["in.id"] as string[]).includes(run.id),
              );
            }
            return Promise.resolve({
              data,
              error: fixture.queryError ? { message: fixture.queryError } : null,
            }).then(resolve);
          },
        };
        return query;
      }
      // Direct job/run/session state writes are deliberately unsupported.
      return {
        select: () => builder("select"),
        insert: (patch: Record<string, unknown>) => builder("insert", patch),
      };
    },
  };
  return { admin, calls, rpc };
}

function vercelRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    status: "canceled",
    sandbox_id: "sb-1",
    sandbox_provider: "vercel",
    sandbox_vercel_project_id: "proj-1",
    sandbox_vercel_team_id: "team-1",
    workspace_id: "w1",
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
const receipt = { job_ids: ["job-1"], run_ids: ["run-1"] };
const input = { reason: "Run canceled by a workspace member.", sessionId: "s1", workspaceId: "w1" };

afterEach(() => {
  vi.clearAllMocks();
  sandboxMocks.stopSandboxById.mockResolvedValue(undefined);
  connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue(null as unknown);
});

describe("cancelSessionWork", () => {
  it("commits workspace-scoped cancellation before reading exact cleanup IDs", async () => {
    const { admin, calls, rpc } = buildAdmin({
      receipt,
      runs: [vercelRun({ sandbox_provider: "fake" })],
    });
    const result = await cancelSessionWork(admin as never, input);
    expect(rpc).toHaveBeenCalledWith("cancel_session_job_attempts", {
      p_park_phase_status: true,
      p_reason: input.reason,
      p_session_id: "s1",
      p_workspace_id: "w1",
    });
    expect(calls[0]).toMatchObject({
      table: "agent_runs",
      op: "select",
      filters: { "eq.workspace_id": "w1", "in.id": ["run-1"] },
    });
    expect(result).toEqual({
      canceledJobIds: ["job-1"],
      canceledRunIds: ["run-1"],
      stoppedSandboxIds: ["sb-1"],
    });
    expect(calls.find((call) => call.table === "agent_run_messages")?.patch).toMatchObject({
      agent_run_id: "run-1",
      workspace_id: "w1",
    });
  });

  it("does not park or stop a successor that starts while old sandbox cleanup awaits", async () => {
    const stopStarted = deferred();
    const finishStop = deferred();
    const runs = [vercelRun({ sandbox_provider: "fake" })];
    let phase = "in_progress";
    const { admin, calls, rpc } = buildAdmin({ receipt, runs });
    rpc.mockImplementation(async () => {
      phase = "rejected";
      return { data: [receipt], error: null };
    });
    sandboxMocks.stopSandboxById.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await finishStop.promise;
    });
    const pending = cancelSessionWork(admin as never, input);
    await stopStarted.promise;
    expect(phase).toBe("rejected");
    phase = "in_progress";
    runs.push(
      vercelRun({ id: "run-2", status: "running", sandbox_id: "sb-2", sandbox_provider: "fake" }),
    );
    finishStop.resolve();
    await pending;
    expect(phase).toBe("in_progress");
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledExactlyOnceWith("sb-1");
    expect(calls.filter((call) => call.op === "select")).toHaveLength(1);
    expect(calls.filter((call) => call.table === "sessions")).toEqual([]);
  });

  it("stops a published successful run from the receipt without labeling it canceled", async () => {
    const { admin, calls } = buildAdmin({
      receipt,
      runs: [vercelRun({ status: "success", sandbox_provider: "fake" })],
    });
    const result = await cancelSessionWork(admin as never, input);
    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledExactlyOnceWith("sb-1");
    expect(calls.some((call) => call.table === "agent_run_messages")).toBe(false);
  });

  it("forwards a queued run identity through the claim gap and accepts its cleanup receipt", async () => {
    const { admin, rpc } = buildAdmin({ receipt, runs: [vercelRun({ sandbox_id: null })] });
    const result = await cancelSessionWork(admin as never, { ...input, expectedRunId: "run-1" });
    expect(rpc).toHaveBeenCalledWith(
      "cancel_session_job_attempts",
      expect.objectContaining({ p_expected_run_id: "run-1" }),
    );
    expect(result.canceledJobIds).toEqual(["job-1"]);
    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does no cleanup when the database refuses a stale expected run", async () => {
    const { admin, calls } = buildAdmin({ runs: [vercelRun({ id: "run-2", status: "running" })] });
    expect(await cancelSessionWork(admin as never, { ...input, expectedRunId: "run-1" })).toEqual({
      canceledJobIds: [],
      canceledRunIds: [],
      stoppedSandboxIds: [],
    });
    expect(calls).toEqual([]);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("leaves phase handling with the caller when requested", async () => {
    const { admin, rpc } = buildAdmin();
    await cancelSessionWork(admin as never, { ...input, parkPhaseStatus: false });
    expect(rpc).toHaveBeenCalledWith(
      "cancel_session_job_attempts",
      expect.objectContaining({ p_park_phase_status: false }),
    );
  });

  it("does not stop unreturned runs or rows from another workspace", async () => {
    const { admin } = buildAdmin({
      receipt,
      runs: [
        vercelRun({ workspace_id: "w2", sandbox_provider: "fake" }),
        vercelRun({ id: "run-2", sandbox_provider: "fake" }),
      ],
    });
    await cancelSessionWork(admin as never, input);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does not begin provider cleanup when the transaction fails", async () => {
    const { admin, calls, rpc } = buildAdmin({ receipt });
    rpc.mockResolvedValueOnce({ data: [], error: { message: "transaction failed" } });
    await expect(cancelSessionWork(admin as never, input)).rejects.toEqual({
      message: "transaction failed",
    });
    expect(calls).toEqual([]);
  });
});

describe("cancelWorkspaceWork", () => {
  it("cancels and parks all listed sessions before provider cleanup begins", async () => {
    const { admin, calls, rpc } = buildAdmin({
      sessions: [{ id: "s1" }, { id: "s2" }],
      runs: [
        vercelRun({ sandbox_provider: "fake" }),
        vercelRun({ id: "run-2", sandbox_id: "sb-2", sandbox_provider: "fake" }),
      ],
    });
    rpc
      .mockResolvedValueOnce({ data: [receipt], error: null })
      .mockResolvedValueOnce({ data: [{ job_ids: ["job-2"], run_ids: ["run-2"] }], error: null });
    sandboxMocks.stopSandboxById.mockImplementation(async () => {
      expect(rpc).toHaveBeenCalledTimes(2);
    });
    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });
    expect(result).toEqual({
      canceledJobIds: ["job-1", "job-2"],
      canceledRunIds: ["run-1", "run-2"],
      stoppedSandboxIds: ["sb-1", "sb-2"],
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "cancel_session_job_attempts", {
      p_park_phase_status: true,
      p_reason: "Workspace deleted.",
      p_session_id: "s2",
      p_workspace_id: "w1",
    });
    expect(calls[0]).toMatchObject({ table: "sessions", filters: { "eq.workspace_id": "w1" } });
    expect(calls.some((call) => call.op === "insert")).toBe(false);
  });

  it("cancels sessions beyond the first database page before provider cleanup", async () => {
    const sessions = Array.from({ length: 501 }, (_, index) => ({
      id: `s${String(index).padStart(4, "0")}`,
    }));
    const { admin, calls, rpc } = buildAdmin({ sessions });
    await cancelWorkspaceWork(admin as never, { reason: "Workspace deleted.", workspaceId: "w1" });
    expect(rpc).toHaveBeenCalledTimes(501);
    expect(rpc).toHaveBeenLastCalledWith(
      "cancel_session_job_attempts",
      expect.objectContaining({ p_session_id: "s0500" }),
    );
    expect(
      calls.filter((call) => call.table === "sessions").map((call) => call.filters["gt.id"]),
    ).toEqual([undefined, "s0499"]);
  });

  it("continues other session cancellations after a failed transaction", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, rpc } = buildAdmin({ sessions: [{ id: "s1" }, { id: "s2" }] });
    rpc
      .mockResolvedValueOnce({ data: [], error: { message: "transaction failed" } })
      .mockResolvedValueOnce({ data: [receipt], error: null });
    expect(
      (
        await cancelWorkspaceWork(admin as never, {
          reason: "Workspace deleted.",
          workspaceId: "w1",
        })
      ).canceledJobIds,
    ).toEqual(["job-1"]);
    expect(rpc).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("is a no-op for an empty workspace", async () => {
    const { admin, rpc } = buildAdmin();
    expect(
      await cancelWorkspaceWork(admin as never, {
        reason: "Workspace deleted.",
        workspaceId: "w1",
      }),
    ).toEqual({ canceledJobIds: [], canceledRunIds: [], stoppedSandboxIds: [] });
    expect(rpc).not.toHaveBeenCalled();
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

  it("attempts cleanup with the current credentials after a connection rotation", async () => {
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "other", teamId: "other", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    } as unknown);

    await stopRunSandbox({} as never, vercelRun());

    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledWith("sb-1", {
      connection: {
        credentials: { projectId: "other", teamId: "other", token: "tok" },
        provider: "vercel",
        revision: "revision-1",
      },
    });
  });

  it("is a no-op when the run has no sandbox", async () => {
    await stopRunSandbox({} as never, vercelRun({ sandbox_id: null }));
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });
});
