import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxConnection } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({
  listRunningSandboxes: vi.fn(),
  stopSandboxById: vi.fn(),
}));
vi.mock("@/lib/sandbox", () => mocked);

import { stopVercelWorkspaceOwnedSandboxes } from "./cleanup";
import { SandboxConnectionActiveWorkError } from "./server";

const connection: Extract<SandboxConnection, { provider: "vercel" }> = {
  credentials: { teamId: "team-1", projectId: "project-1", token: "test-token" },
  provider: "vercel",
  revision: "revision-1",
};
const project = {
  sandbox_provider: "vercel",
  sandbox_vercel_team_id: "team-1",
  sandbox_vercel_project_id: "project-1",
  workspace_id: "workspace-1",
};
function run(overrides: Record<string, unknown> = {}) {
  return {
    ...project,
    sandbox_id: "sandbox-1",
    agent_job_id: "job-1",
    attempt_count: 2,
    status: "success",
    ...overrides,
  };
}
function buildAdmin(
  input: {
    runs?: Array<Record<string, unknown>>;
    jobs?: Array<Record<string, unknown>>;
    checks?: Array<Record<string, unknown>>;
    heartbeats?: Array<Record<string, unknown>>;
    failedTable?: string;
  } = {},
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_runs: input.runs ?? [run()],
    agent_jobs: input.jobs ?? [{ id: "job-1", attempt_count: 2, status: "running" }],
    sandbox_capability_checks: input.checks ?? [],
    worker_heartbeats: input.heartbeats ?? [],
  };
  return {
    from: vi.fn((table: string) => ({
      select: () => {
        const filters = new Map<string, unknown>();
        const minimums = new Map<string, string>();
        const query = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return query;
          },
          in: (column: string, value: unknown) => {
            filters.set(column, value);
            return query;
          },
          gte: (column: string, value: string) => {
            minimums.set(column, value);
            return query;
          },
          then: (
            resolve: (value: {
              data: Array<Record<string, unknown>> | null;
              error: Error | null;
            }) => void,
          ) =>
            resolve({
              data:
                input.failedTable === table
                  ? null
                  : tables[table].filter(
                      (row) =>
                        [...filters].every(([column, value]) =>
                          Array.isArray(value)
                            ? value.includes(row[column])
                            : value === row[column],
                        ) && [...minimums].every(([column, value]) => String(row[column]) >= value),
                    ),
              error: input.failedTable === table ? new Error(`${table} unavailable`) : null,
            }),
        };
        return query;
      },
    })),
  };
}
async function cleanup(admin: ReturnType<typeof buildAdmin>) {
  return stopVercelWorkspaceOwnedSandboxes({
    admin: admin as never,
    connection,
    workspaceId: "workspace-1",
  });
}

beforeEach(() => {
  mocked.listRunningSandboxes
    .mockReset()
    .mockResolvedValue([{ id: "sandbox-1", status: "running", createdAt: Date.now() - 600_000 }]);
  mocked.stopSandboxById.mockReset().mockResolvedValue(undefined);
});

describe("Vercel connection cleanup execution ownership", () => {
  it.each(["queued", "started", "running"])(
    "defers credential changes while a successful run's exact job attempt is %s",
    async (status) => {
      await expect(
        cleanup(buildAdmin({ jobs: [{ id: "job-1", attempt_count: 2, status }] })),
      ).rejects.toBeInstanceOf(SandboxConnectionActiveWorkError);
      expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    },
  );

  it("checks all protected runs before stopping even an earlier orphan sandbox", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: 0 },
      { id: "sandbox-1", status: "running", createdAt: 0 },
    ]);
    await expect(
      cleanup(
        buildAdmin({
          runs: [run({ sandbox_id: "orphan", status: "error" }), run()],
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxConnectionActiveWorkError);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each([
    { attempt_count: 1, status: "success" },
    { attempt_count: null, status: "success" },
    { attempt_count: 2, status: "error" },
    { attempt_count: 2, status: "canceled" },
  ])("cleans a terminal sandbox without current successful ownership (%j)", async (history) => {
    await cleanup(buildAdmin({ runs: [run(history)] }));
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      connection,
      throwOnError: true,
    });
  });

  it("cleans a successful run after its matching job is terminal", async () => {
    await cleanup(buildAdmin({ jobs: [{ id: "job-1", attempt_count: 2, status: "success" }] }));
    expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
  });

  it("protects a completed attempt until its worker stops advertising the job", async () => {
    const heartbeats = [{ active_job_ids: ["job-1"], last_heartbeat_at: new Date().toISOString() }];
    const admin = buildAdmin({
      jobs: [{ id: "job-1", attempt_count: 2, status: "success" }],
      heartbeats,
    });
    await expect(cleanup(admin)).rejects.toBeInstanceOf(SandboxConnectionActiveWorkError);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    heartbeats[0].active_job_ids = [];
    await cleanup(admin);
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
      await cleanup(
        buildAdmin({
          runs: [run({ attempt_count: state.runAttempt })],
          jobs: state.known
            ? [{ id: "job-1", attempt_count: state.jobAttempt, status: state.status }]
            : [],
          heartbeats: [
            {
              active_job_ids: ["job-1"],
              last_heartbeat_at: new Date(Date.now() - state.ageMs).toISOString(),
            },
          ],
        }),
      );
      expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when a completed job's worker heartbeat cannot be read", async () => {
    await expect(
      cleanup(
        buildAdmin({
          jobs: [{ id: "job-1", attempt_count: 2, status: "success" }],
          failedTable: "worker_heartbeats",
        }),
      ),
    ).rejects.toThrow("worker_heartbeats unavailable");
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each(["queued", "started", "running"])(
    "preserves %s run references regardless of attempt metadata",
    async (status) => {
      await cleanup(buildAdmin({ runs: [run({ status, attempt_count: null })], jobs: [] }));
      expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "success"])(
    "honors another workspace's %s reference to a shared project sandbox",
    async (status) => {
      await cleanup(
        buildAdmin({
          runs: [run({ status: "error" }), run({ workspace_id: "workspace-2", status })],
        }),
      );
      expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    },
  );

  it("skips another workspace's heartbeat-protected sandbox without blocking credential changes", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: 0 },
      { id: "sandbox-1", status: "running", createdAt: 0 },
    ]);
    await cleanup(
      buildAdmin({
        runs: [
          run({ sandbox_id: "orphan", status: "error" }),
          run({ status: "error" }),
          run({ workspace_id: "workspace-2" }),
        ],
        jobs: [{ id: "job-1", attempt_count: 2, status: "success" }],
        heartbeats: [{ active_job_ids: ["job-1"], last_heartbeat_at: new Date().toISOString() }],
      }),
    );
    expect(mocked.stopSandboxById).toHaveBeenCalledExactlyOnceWith("orphan", {
      connection,
      throwOnError: true,
    });
  });

  it("does not stop sandboxes owned only by another workspace or unknown to Wallie", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "sandbox-1", status: "running", createdAt: 0 },
      { id: "unknown", status: "running", createdAt: 0 },
    ]);
    await cleanup(buildAdmin({ runs: [run({ status: "error", workspace_id: "workspace-2" })] }));
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each([
    { sandbox_vercel_project_id: "other-project" },
    { sandbox_vercel_team_id: "other-team" },
    { sandbox_provider: "e2b" },
  ])("requires the recorded provider project identity before cleanup (%j)", async (identity) => {
    await cleanup(buildAdmin({ runs: [run({ status: "error", ...identity })] }));
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("protects a shared sandbox used by a fresh capability check in another workspace", async () => {
    await cleanup(
      buildAdmin({
        runs: [run({ status: "error" })],
        checks: [
          {
            ...project,
            workspace_id: "workspace-2",
            sandbox_id: "sandbox-1",
            status: "running",
            checked_at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each(["agent_runs", "agent_jobs", "sandbox_capability_checks"])(
    "fails closed when %s cannot be read",
    async (failedTable) => {
      await expect(cleanup(buildAdmin({ failedTable }))).rejects.toThrow(
        `${failedTable} unavailable`,
      );
      expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    },
  );
});
