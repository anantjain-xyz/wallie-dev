import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxConnection } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({
  listRunningSandboxes: vi.fn(),
  stopSandboxById: vi.fn(),
}));
vi.mock("@/lib/sandbox", () => mocked);

import { stopVercelWorkspaceOwnedSandboxes } from "./cleanup";

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
    failedTable?: string;
  } = {},
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_runs: input.runs ?? [run()],
    agent_jobs: input.jobs ?? [{ id: "job-1", attempt_count: 2, status: "running" }],
    sandbox_capability_checks: input.checks ?? [],
  };
  return {
    from: vi.fn((table: string) => ({
      select: () => {
        const filters = new Map<string, unknown>();
        const query = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return query;
          },
          in: (column: string, value: unknown) => {
            filters.set(column, value);
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
                  : tables[table].filter((row) =>
                      [...filters].every(([column, value]) =>
                        Array.isArray(value) ? value.includes(row[column]) : value === row[column],
                      ),
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
  it("protects a successful run while its exact job attempt is still active", async () => {
    await cleanup(buildAdmin());
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
