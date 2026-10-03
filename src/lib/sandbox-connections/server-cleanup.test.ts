import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxConnection } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({
  listRunningSandboxes: vi.fn(),
  stopSandboxById: vi.fn(),
}));
vi.mock("@/lib/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox")>()),
  listRunningSandboxes: mocked.listRunningSandboxes,
  stopSandboxById: mocked.stopSandboxById,
}));

import { SandboxConnectionActiveWorkError, stopWorkspaceOwnedSandboxes } from "./server";

type Row = Record<string, unknown>;
function adminFor(input: { run: Row; jobs?: Row[]; heartbeats?: Row[]; failedTable?: string }) {
  const tables: Record<string, Row[]> = {
    agent_runs: [input.run],
    agent_jobs: input.jobs ?? [{ id: "job-1", status: "success", attempt_count: 2 }],
    worker_heartbeats: input.heartbeats ?? [],
    sandbox_capability_checks: [],
  };
  return {
    from: (table: string) => {
      let rows = tables[table] ?? [];
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        gte: (key: string, cutoff: string) => {
          rows = rows.filter((row) => String(row[key]) >= cutoff);
          return query;
        },
        then: (resolve: (value: { data: Row[]; error: Error | null }) => void) =>
          resolve({
            data: rows,
            error: table === input.failedTable ? new Error(`${table} unavailable`) : null,
          }),
      };
      return query;
    },
  };
}

function run(provider: string, overrides: Row = {}): Row {
  return {
    agent_job_id: "job-1",
    attempt_count: 2,
    sandbox_id: "sandbox-1",
    sandbox_provider: provider,
    sandbox_connection_revision: "revision-1",
    status: "success",
    workspace_id: "workspace-1",
    ...overrides,
  };
}

function heartbeat(ageMs = 0): Row {
  return {
    active_job_ids: ["job-1"],
    last_heartbeat_at: new Date(Date.now() - ageMs).toISOString(),
  };
}

beforeEach(() => {
  mocked.listRunningSandboxes
    .mockReset()
    .mockResolvedValue([{ id: "sandbox-1", status: "running", createdAt: Date.now() - 600_000 }]);
  mocked.stopSandboxById.mockReset().mockResolvedValue(undefined);
});

describe.each(["e2b", "daytona"] as const)("%s credential cleanup ownership", (provider) => {
  const connection: SandboxConnection = {
    provider,
    credentials: { apiKey: "provider-secret" },
    revision: "revision-1",
  };
  const cleanup = (admin: ReturnType<typeof adminFor>) =>
    stopWorkspaceOwnedSandboxes({
      admin: admin as never,
      connection,
      workspaceId: "workspace-1",
    });

  it("blocks credential mutation when the current published attempt has a fresh job heartbeat", async () => {
    const heartbeats = [heartbeat()];
    const admin = adminFor({ run: run(provider), heartbeats });
    await expect(cleanup(admin)).rejects.toBeInstanceOf(SandboxConnectionActiveWorkError);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    heartbeats[0].active_job_ids = [];
    await cleanup(admin);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      connection,
      throwOnError: true,
    });
  });

  it.each(["missing", "stale", "old attempt"])(
    "cleans up with %s heartbeat ownership",
    async (state) => {
      await cleanup(
        adminFor({
          run: run(provider, state === "old attempt" ? { attempt_count: 1 } : {}),
          heartbeats: state === "missing" ? [] : [heartbeat(state === "stale" ? 61_000 : 0)],
        }),
      );
      expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
        connection,
        throwOnError: true,
      });
    },
  );

  it("protects a published run while its matching job is still active", async () => {
    await expect(
      cleanup(
        adminFor({
          run: run(provider),
          jobs: [{ id: "job-1", status: "running", attempt_count: 2 }],
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxConnectionActiveWorkError);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each(["error", "canceled"])(
    "cleans %s execution despite a worker heartbeat",
    async (status) => {
      await cleanup(adminFor({ run: run(provider, { status }), heartbeats: [heartbeat()] }));
      expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
    },
  );

  it.each(["agent_runs", "agent_jobs", "worker_heartbeats"])(
    "fails closed when %s lookup fails",
    async (failedTable) => {
      await expect(cleanup(adminFor({ run: run(provider), failedTable }))).rejects.toThrow(
        `${failedTable} unavailable`,
      );
      expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    },
  );

  it.each([
    { workspace_id: "workspace-other" },
    { sandbox_provider: "vercel" },
    { sandbox_connection_revision: "revision-other" },
  ])("does not touch sandbox references outside this connection (%j)", async (identity) => {
    await cleanup(adminFor({ run: run(provider, identity) }));
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });
});
