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

import { archiveSession } from "@/lib/pipeline/archive";
import {
  cancelSessionWork,
  cancelWorkspaceWork,
  stopRunSandbox,
  type SessionWorkReceipt,
} from "@/lib/pipeline/cancel";

type Run = {
  id: string;
  status: "canceled" | "success" | "running";
  job_status?: "canceled" | "success" | "running";
  agent_job_id?: string | null;
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
    runLookupErrors?: string[];
    recoveryError?: string;
    archiveState?: { id: string; archived_at: string; phase_status: string; updated_at: string };
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
          is(column: string, value: unknown) {
            filters[`is.${column}`] = value;
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
          single() {
            calls.push({ filters, op, patch, table });
            return Promise.resolve({ data: fixture.archiveState ?? null, error: null });
          },
          not(column: string, operator: string, value: unknown) {
            filters[`not.${column}`] = [operator, value];
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
            let queryError = fixture.queryError;
            if (table === "agent_runs") {
              const withoutJob = "is.agent_job_id" in filters;
              const recovering = Boolean(filters["in.job.status"]) || withoutJob;
              data = (fixture.runs ?? [])
                .filter((run) => run.workspace_id === filters["eq.workspace_id"])
                .filter(
                  (run) => !filters["in.id"] || (filters["in.id"] as string[]).includes(run.id),
                )
                .filter(
                  (run) =>
                    !filters["in.status"] ||
                    (filters["in.status"] as string[]).includes(run.status),
                )
                .filter(
                  (run) =>
                    !filters["in.job.status"] ||
                    (run.agent_job_id !== null &&
                      (filters["in.job.status"] as string[]).includes(
                        run.job_status ?? "canceled",
                      )),
                )
                .filter((run) => !withoutJob || run.agent_job_id === null)
                .filter((run) => !filters["not.sandbox_id"] || run.sandbox_id !== null)
                .filter((run) => !filters["gt.id"] || run.id > (filters["gt.id"] as string))
                .slice(0, filters.limit as number | undefined);
              queryError = recovering ? fixture.recoveryError : fixture.runLookupErrors?.shift();
            }
            return Promise.resolve({
              data,
              error: queryError ? { message: queryError } : null,
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
  vi.restoreAllMocks();
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

  it("retries metadata reads using the original receipt without canceling again", async () => {
    const { admin, calls, rpc } = buildAdmin({
      receipt,
      runs: [
        vercelRun({ sandbox_provider: "fake" }),
        vercelRun({ id: "run-2", status: "running", sandbox_id: "sb-2", sandbox_provider: "fake" }),
      ],
      runLookupErrors: ["temporary failure"],
    });
    const result = await cancelSessionWork(admin as never, input);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.table === "agent_runs").map((call) => call.filters["in.id"]),
    ).toEqual([["run-1"], ["run-1"]]);
    expect(result.stoppedSandboxIds).toEqual(["sb-1"]);
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledExactlyOnceWith("sb-1");
  });

  it("reports committed cancellation after bounded metadata failures and leaves runs for the reaper", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vercelRun({ sandbox_provider: "fake" });
    const { admin, calls, rpc } = buildAdmin({
      receipt,
      runs: [run],
      runLookupErrors: ["db down", "db down", "db down"],
    });
    expect(await cancelSessionWork(admin as never, input)).toEqual({
      canceledJobIds: ["job-1"],
      canceledRunIds: ["run-1"],
      stoppedSandboxIds: [],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.table === "agent_runs")).toHaveLength(3);
    expect(run).toMatchObject({ status: "canceled", sandbox_id: "sb-1" });
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("returns committed archive state when receipt metadata remains unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const archivedAt = "2026-10-03T00:00:00.000Z";
    const { admin, rpc } = buildAdmin({
      receipt,
      runLookupErrors: ["db down", "db down", "db down"],
      archiveState: {
        id: "s1",
        archived_at: archivedAt,
        phase_status: "awaiting_review",
        updated_at: archivedAt,
      },
    });
    await expect(archiveSession(admin as never, input)).resolves.toEqual({
      id: "s1",
      archivedAt,
      phaseStatus: "awaiting_review",
      updatedAt: archivedAt,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "archive_session_job_attempts",
      expect.objectContaining({ p_session_id: "s1", p_workspace_id: "w1" }),
    );
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

  it("fails closed when a cancellation transaction cannot complete", async () => {
    const { admin, rpc } = buildAdmin({ sessions: [{ id: "s1" }, { id: "s2" }] });
    rpc.mockResolvedValueOnce({ data: [], error: { message: "transaction failed" } });
    await expect(
      cancelWorkspaceWork(admin as never, { reason: "Workspace deleted.", workspaceId: "w1" }),
    ).rejects.toEqual({ message: "transaction failed" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("retries cleanup of prior terminal owners after losing the cancellation receipt", async () => {
    const runs = [
      vercelRun({ sandbox_provider: "fake" }),
      vercelRun({
        id: "run-published",
        status: "success",
        sandbox_id: "sb-published",
        sandbox_provider: "fake",
      }),
      vercelRun({
        id: "run-successor",
        status: "running",
        job_status: "running",
        sandbox_id: "sb-successor",
        sandbox_provider: "fake",
      }),
      vercelRun({
        id: "run-publishing",
        status: "success",
        job_status: "running",
        sandbox_id: "sb-publishing",
        sandbox_provider: "fake",
      }),
    ];
    const { admin, rpc } = buildAdmin({
      sessions: [{ id: "s1" }],
      runs,
      runLookupErrors: ["db down", "db down", "db down"],
    });
    rpc.mockResolvedValueOnce({ data: [receipt], error: null });
    const deletion = { reason: "Workspace deleted.", workspaceId: "w1" };
    await expect(cancelWorkspaceWork(admin as never, deletion)).rejects.toEqual({
      message: "db down",
    });
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
    const result = await cancelWorkspaceWork(admin as never, deletion);
    expect(result.canceledJobIds).toEqual([]);
    expect(result.canceledRunIds).toEqual(["run-1", "run-published"]);
    expect(result.stoppedSandboxIds).toEqual(["sb-1", "sb-published"]);
    expect(sandboxMocks.stopSandboxById).toHaveBeenNthCalledWith(1, "sb-1", { throwOnError: true });
    expect(sandboxMocks.stopSandboxById).toHaveBeenNthCalledWith(2, "sb-published", {
      throwOnError: true,
    });
  });

  it("recovers a prior canceled legacy run with no parent job after losing its receipt", async () => {
    const legacy = vercelRun({ id: "legacy-run", agent_job_id: null, sandbox_provider: "fake" });
    const { admin, rpc } = buildAdmin({
      sessions: [{ id: "s1" }],
      runs: [
        legacy,
        vercelRun({
          id: "active-legacy-run",
          agent_job_id: null,
          status: "running",
          sandbox_id: "active-sandbox",
          sandbox_provider: "fake",
        }),
      ],
      runLookupErrors: ["db down", "db down", "db down"],
    });
    rpc.mockResolvedValueOnce({ data: [{ job_ids: [], run_ids: [legacy.id] }], error: null });
    const deletion = { reason: "Workspace deleted.", workspaceId: "w1" };
    await expect(cancelWorkspaceWork(admin as never, deletion)).rejects.toEqual({
      message: "db down",
    });
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
    const result = await cancelWorkspaceWork(admin as never, deletion);
    expect(result.canceledJobIds).toEqual([]);
    expect(result.canceledRunIds).toEqual([legacy.id]);
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledExactlyOnceWith("sb-1", {
      throwOnError: true,
    });
  });

  it("recovers terminal sandbox references beyond the first database page", async () => {
    const runs = Array.from({ length: 501 }, (_, index) =>
      vercelRun({
        id: `run-${String(index).padStart(4, "0")}`,
        sandbox_id: `sb-${index}`,
        sandbox_provider: "fake",
      }),
    );
    const { admin, calls } = buildAdmin({ runs });
    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });
    expect(result.stoppedSandboxIds).toHaveLength(501);
    expect(result.stoppedSandboxIds.at(-1)).toBe("sb-500");
    expect(
      calls
        .filter((call) => call.table === "agent_runs" && call.filters["in.job.status"])
        .map((call) => call.filters["gt.id"]),
    ).toEqual([undefined, "run-0499"]);
  });

  it("fails closed if terminal ownership cannot be read", async () => {
    const { admin } = buildAdmin({ recoveryError: "cannot list runs" });
    await expect(
      cancelWorkspaceWork(admin as never, { reason: "Workspace deleted.", workspaceId: "w1" }),
    ).rejects.toEqual({ message: "cannot list runs" });
  });

  it("skips a confirmed absent connection without falsely reporting the sandbox stopped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { admin } = buildAdmin({ runs: [vercelRun()] });
    const result = await cancelWorkspaceWork(admin as never, {
      reason: "Workspace deleted.",
      workspaceId: "w1",
    });
    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(sandboxMocks.stopSandboxById).not.toHaveBeenCalled();
  });

  it("retains workspace ownership on credential lookup or strict provider stop failures", async () => {
    const { admin } = buildAdmin({ runs: [vercelRun()] });
    connectionMocks.loadWorkspaceSandboxConnection.mockRejectedValueOnce(
      new Error("credential lookup unavailable"),
    );
    await expect(
      cancelWorkspaceWork(admin as never, { reason: "Workspace deleted.", workspaceId: "w1" }),
    ).rejects.toThrow("credential lookup unavailable");
    connectionMocks.loadWorkspaceSandboxConnection.mockResolvedValue({
      connection: { provider: "vercel", credentials: {}, revision: "revision-1" },
    });
    sandboxMocks.stopSandboxById.mockRejectedValueOnce(new Error("stop unavailable"));
    await expect(
      cancelWorkspaceWork(admin as never, { reason: "Workspace deleted.", workspaceId: "w1" }),
    ).rejects.toThrow("stop unavailable");
    expect(sandboxMocks.stopSandboxById).toHaveBeenCalledWith(
      "sb-1",
      expect.objectContaining({ throwOnError: true }),
    );
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
