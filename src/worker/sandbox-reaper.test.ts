import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  listRunningSandboxes: vi.fn(),
  loadAllConnectedSandboxConnections: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
  listRunningSandboxes: mocked.listRunningSandboxes,
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadAllConnectedSandboxConnections: mocked.loadAllConnectedSandboxConnections,
}));

import { reapOrphanSandboxes } from "./sandbox-reaper";

interface ClaimedRow {
  agent_job_id?: string | null;
  attempt_count?: number | null;
  checked_at?: string;
  sandbox_id: string;
  sandbox_connection_revision?: string;
  sandbox_provider?: string;
  sandbox_vercel_project_id?: string;
  sandbox_vercel_team_id?: string;
  status?: string;
  workspace_id?: string;
}

function buildAdminMock(
  claimed: ClaimedRow[],
  opts: {
    activeJobIds?: string[];
    activeJobAttempts?: Record<string, number>;
    failJobs?: boolean;
    jobs?: Array<{ id: string; attempt_count: number; status: string }>;
    heartbeats?: Array<{ active_job_ids: string[]; last_heartbeat_at: string }>;
    failHeartbeats?: boolean;
    checks?: ClaimedRow[];
    fail?: boolean;
    failChecks?: boolean;
  } = {},
) {
  const queries: Array<{ filters: Record<string, unknown>; ids: string[] }> = [];
  const jobs =
    opts.jobs ??
    (opts.activeJobIds ?? []).map((id) => ({
      id,
      attempt_count: opts.activeJobAttempts?.[id] ?? 1,
      status: "running",
    }));
  const selectProjectRows = (rows: ClaimedRow[], filters: Map<string, unknown>) => {
    const sandboxIds = filters.get("sandbox_id");
    const ids = Array.isArray(sandboxIds) ? sandboxIds : [];

    return rows
      .map((row) => ({
        attempt_count: 1,
        sandbox_provider: "vercel",
        sandbox_connection_revision: "revision-1",
        sandbox_vercel_project_id: "prj_123",
        sandbox_vercel_team_id: "team_123",
        checked_at: new Date().toISOString(),
        status: "running",
        workspace_id: "workspace-1",
        ...row,
      }))
      .filter(
        (row) =>
          ids.includes(row.sandbox_id) &&
          [...filters].every(([column, value]) =>
            column === "sandbox_id"
              ? Array.isArray(value) && value.includes(row.sandbox_id)
              : row[column as keyof ClaimedRow] === value,
          ),
      );
  };

  return {
    admin: {
      from: (name: string) => {
        if (name === "agent_jobs") {
          const filters = new Map<string, unknown>();
          const chain = {
            in: (column: string, value: unknown) => {
              filters.set(column, value);
              return chain;
            },
            then: (
              resolve: (value: {
                data: Array<{ id: string; attempt_count: number; status: string }>;
                error: { message: string } | null;
              }) => void,
            ) => {
              resolve({
                data: jobs.filter((job) =>
                  [...filters].every(
                    ([column, value]) =>
                      Array.isArray(value) && value.includes(job[column as keyof typeof job]),
                  ),
                ),
                error: opts.failJobs ? { message: "jobs unavailable" } : null,
              });
            },
          };
          return {
            select: () => chain,
          };
        }

        if (name === "worker_heartbeats") {
          return {
            select: () => ({
              gte: (_column: string, cutoff: string) =>
                Promise.resolve({
                  data: (opts.heartbeats ?? []).filter((row) => row.last_heartbeat_at >= cutoff),
                  error: opts.failHeartbeats ? { message: "heartbeats unavailable" } : null,
                }),
            }),
          };
        }

        if (name !== "agent_runs" && name !== "sandbox_capability_checks") {
          throw new Error(`unexpected table: ${name}`);
        }
        const filters = new Map<string, unknown>();
        const chain = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return chain;
          },
          in: (column: string, value: unknown) => {
            filters.set(column, value);
            return chain;
          },
          then: (
            resolve: (value: {
              data: ClaimedRow[] | null;
              error: { message: string } | null;
            }) => void,
          ) => {
            const sandboxIds = filters.get("sandbox_id");
            const ids = Array.isArray(sandboxIds) ? sandboxIds : [];
            queries.push({ filters: Object.fromEntries(filters), ids });
            if (opts.fail || (name === "sandbox_capability_checks" && opts.failChecks)) {
              resolve({ data: null, error: { message: "db down" } });
              return;
            }
            resolve({
              data: selectProjectRows(
                name === "agent_runs" ? claimed : (opts.checks ?? []),
                filters,
              ),
              error: null,
            });
          },
        };
        return {
          select: () => chain,
        };
      },
    },
    queries,
  };
}

beforeEach(() => {
  mocked.stopSandboxById.mockClear();
  mocked.listRunningSandboxes.mockReset();
  mocked.loadAllConnectedSandboxConnections.mockResolvedValue([
    {
      connection: {
        credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
        provider: "vercel",
        revision: "revision-1",
      },
      workspaceId: "workspace-1",
    },
  ]);
});

const TEN_MIN_MS = 10 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

describe("reapOrphanSandboxes", () => {
  it("returns early when the provider has no active sandboxes", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([]);
    const { admin } = buildAdminMock([]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(0);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({
      connection: {
        credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
        provider: "vercel",
        revision: "revision-1",
      },
      workspaceId: "workspace-1",
    });
  });

  it("ignores sandboxes inside the grace window", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "fresh", status: "running", createdAt: Date.now() - ONE_MIN_MS },
    ]);
    const { admin, queries } = buildAdminMock([]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(1);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(queries).toHaveLength(0); // never queried the DB
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("stops only orphaned sandboxes; leaves claimed ones running", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "claimed", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan-1", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan-2", status: "pending", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([
      { sandbox_id: "claimed", status: "running" },
      { sandbox_id: "orphan-1", status: "error" },
      { sandbox_id: "orphan-2", status: "success" },
    ]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(3);
    expect(result.reapedSandboxIds.sort()).toEqual(["orphan-1", "orphan-2"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-1", {
      connection: expect.objectContaining({ provider: "vercel", revision: "revision-1" }),
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-2", {
      connection: expect.objectContaining({ provider: "vercel", revision: "revision-1" }),
    });
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith(
      "claimed",
      expect.objectContaining({ connection: expect.anything() }),
    );
  });

  it("leaves a sandbox claimed by another workspace in the same Vercel project", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "shared-claimed", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([
      {
        sandbox_id: "shared-claimed",
        status: "running",
        workspace_id: "workspace-2",
      },
      {
        sandbox_id: "orphan",
        status: "error",
        workspace_id: "workspace-2",
      },
    ]);

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith(
      "shared-claimed",
      expect.objectContaining({ connection: expect.anything() }),
    );
  });

  it("reaps terminal sandbox capability checks recorded in the Vercel project", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "capability-orphan", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([], {
      checks: [{ sandbox_id: "capability-orphan", status: "error" }],
    });

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual(["capability-orphan"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("capability-orphan", {
      connection: expect.objectContaining({ provider: "vercel", revision: "revision-1" }),
    });
  });

  it("reaps stale running sandbox capability checks after the stale cutoff", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "stale-capability-check", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([], {
      checks: [
        {
          checked_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          sandbox_id: "stale-capability-check",
          status: "running",
        },
      ],
    });

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual(["stale-capability-check"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("stale-capability-check", {
      connection: expect.objectContaining({ provider: "vercel", revision: "revision-1" }),
    });
  });

  it("keeps fresh running sandbox capability checks active", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "fresh-capability-check", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([], {
      checks: [{ sandbox_id: "fresh-capability-check", status: "running" }],
    });

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does not reap a sandbox whose agent job is still active after run completion", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "post-run", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock(
      [{ agent_job_id: "job-post-run", sandbox_id: "post-run", status: "success" }],
      { activeJobIds: ["job-post-run"] },
    );

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("protects a completed attempt until its worker stops advertising the job", async () => {
    mocked.listRunningSandboxes.mockResolvedValue([
      { id: "published", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const heartbeats = [{ active_job_ids: ["job-1"], last_heartbeat_at: new Date().toISOString() }];
    const { admin } = buildAdminMock(
      [{ sandbox_id: "published", agent_job_id: "job-1", attempt_count: 2, status: "success" }],
      { jobs: [{ id: "job-1", attempt_count: 2, status: "success" }], heartbeats },
    );

    expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    heartbeats[0].active_job_ids = [];
    expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual(["published"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "success", jobAttempt: 2, runAttempt: 2, ageMs: 61_000, known: true },
    { status: "canceled", jobAttempt: 2, runAttempt: 2, ageMs: 0, known: true },
    { status: "error", jobAttempt: 2, runAttempt: 2, ageMs: 0, known: true },
    { status: "success", jobAttempt: 3, runAttempt: 2, ageMs: 0, known: true },
    { status: "running", jobAttempt: 3, runAttempt: 2, ageMs: 0, known: true },
    { status: "success", jobAttempt: 2, runAttempt: null, ageMs: 0, known: true },
    { status: "success", jobAttempt: 2, runAttempt: 2, ageMs: 0, known: false },
  ])(
    "does not extend cleanup protection for ineligible heartbeat ownership (%j)",
    async (state) => {
      mocked.listRunningSandboxes.mockResolvedValueOnce([
        { id: "published", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      ]);
      const { admin } = buildAdminMock(
        [
          {
            sandbox_id: "published",
            agent_job_id: "job-1",
            attempt_count: state.runAttempt,
            status: "success",
          },
        ],
        {
          jobs: state.known
            ? [{ id: "job-1", attempt_count: state.jobAttempt, status: state.status }]
            : [],
          heartbeats: [
            {
              active_job_ids: ["job-1"],
              last_heartbeat_at: new Date(Date.now() - state.ageMs).toISOString(),
            },
          ],
        },
      );
      expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual(["published"]);
      expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when a completed job's worker heartbeat cannot be read", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "published", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock(
      [{ sandbox_id: "published", agent_job_id: "job-1", attempt_count: 2, status: "success" }],
      { jobs: [{ id: "job-1", attempt_count: 2, status: "success" }], failHeartbeats: true },
    );
    expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("reaps a prior successful attempt when the same job is running a newer attempt", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "old-success", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "current-success", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock(
      [
        { sandbox_id: "old-success", agent_job_id: "job-1", attempt_count: 1, status: "success" },
        {
          sandbox_id: "current-success",
          agent_job_id: "job-1",
          attempt_count: 2,
          status: "success",
        },
      ],
      { activeJobIds: ["job-1"], activeJobAttempts: { "job-1": 2 } },
    );
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.reapedSandboxIds).toEqual(["old-success"]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith("current-success", expect.anything());
  });

  it("does not let legacy NULL ownership or an errored run protect a newer job's sandbox", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "legacy-success", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "failed-attempt", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock(
      [
        {
          sandbox_id: "legacy-success",
          agent_job_id: "job-1",
          attempt_count: null,
          status: "success",
        },
        { sandbox_id: "failed-attempt", agent_job_id: "job-1", attempt_count: 2, status: "error" },
      ],
      { activeJobIds: ["job-1"], activeJobAttempts: { "job-1": 2 } },
    );
    expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual([
      "legacy-success",
      "failed-attempt",
    ]);
  });

  it("does not reap a published sandbox when its job ownership cannot be read", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "published", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock(
      [{ sandbox_id: "published", agent_job_id: "job-1", attempt_count: 1, status: "success" }],
      { failJobs: true },
    );
    expect((await reapOrphanSandboxes(admin as never)).reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("requires matching Vercel project metadata before treating a sandbox as known", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "same-id", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([
      {
        sandbox_id: "same-id",
        sandbox_vercel_project_id: "prj_other",
        sandbox_vercel_team_id: "team_123",
        status: "error",
        workspace_id: "workspace-2",
      },
    ]);

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does not stop unknown provider sandboxes in the workspace Vercel project", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "unknown", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([]);

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("logs and bails out when the DB query for claimed runs fails", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([], { fail: true });
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("respects a custom grace window", async () => {
    // Grace = 30s. Sandbox is 60s old → eligible for reaping.
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: Date.now() - 60_000 },
    ]);
    const { admin } = buildAdminMock([{ sandbox_id: "orphan", status: "error" }]);
    const result = await reapOrphanSandboxes(admin as never, { graceMs: 30_000 });
    expect(result.reapedSandboxIds).toEqual(["orphan"]);
  });
});
