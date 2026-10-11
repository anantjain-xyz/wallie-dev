import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({
  loadWorkspaceSandboxConnection: vi.fn().mockResolvedValue({
    connection: { provider: "e2b", revision: "revision-1", credentials: { apiKey: "fixture" } },
  }),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceProviderSandboxes: vi.fn().mockResolvedValue({ stoppedSandboxIds: [] }),
}));
vi.mock("@/lib/sandbox", () => ({ stopSandboxById: mocked.stopSandboxById }));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
}));
vi.mock("@/lib/vercel-sandbox/teardown", () => ({
  stopWorkspaceProviderSandboxes: mocked.stopWorkspaceProviderSandboxes,
}));

import { removeWorkspaceStoragePrefix, resumeWorkspaceDeletion } from "./deletion";

const workspaceId = "workspace-1";
function operation(
  overrides: Partial<Tables<"workspace_resource_operations">> = {},
): Tables<"workspace_resource_operations"> {
  return {
    created_at: new Date().toISOString(),
    connection_revision: null,
    id: "operation-1",
    kind: "sandbox",
    provider: "e2b",
    recovery_after: new Date(Date.now() + 60_000).toISOString(),
    resource_id: null,
    settled_at: null,
    storage_bucket: null,
    workspace_id: workspaceId,
    ...overrides,
  };
}

function fixture(initialOperations: Tables<"workspace_resource_operations">[] = []) {
  const state = {
    deleting: true,
    exists: true,
    operations: initialOperations,
    objects: new Map<string, Set<string>>(),
    removeFailure: false,
    reservationDeleteFailure: false,
    lateSandboxId: null as string | null,
  };
  const lists: Array<{ bucket: string; prefix: string; limit: number }> = [];
  const removals: string[][] = [];
  const storage = {
    from: (bucket: string) => ({
      list: async (prefix: string, options: { limit: number }) => {
        lists.push({ bucket, prefix, limit: options.limit });
        const names = new Map<string, { id: string | null; name: string }>();
        for (const path of [...(state.objects.get(bucket) ?? [])].sort()) {
          if (!path.startsWith(`${prefix}/`)) continue;
          const suffix = path.slice(prefix.length + 1);
          const [name] = suffix.split("/");
          names.set(name!, { id: suffix.includes("/") ? null : path, name: name! });
        }
        return { data: [...names.values()].slice(0, options.limit), error: null };
      },
      remove: async (paths: string[]) => {
        if (state.removeFailure) return { data: null, error: new Error("Storage unavailable") };
        removals.push(paths);
        for (const path of paths) state.objects.get(bucket)?.delete(path);
        return { data: [], error: null };
      },
    }),
  };
  const from = (table: string) => {
    let deleting = false;
    const filters: Array<(row: Tables<"workspace_resource_operations">) => boolean> = [];
    const query = {
      select: () => query,
      order: () => query,
      limit: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column as keyof typeof row] === value);
        return query;
      },
      is: (column: string, value: null) => {
        filters.push((row) => row[column as keyof typeof row] === value);
        return query;
      },
      gt: (column: "id", value: string) => {
        filters.push((row) => row[column] > value);
        return query;
      },
      delete: () => {
        deleting = true;
        return query;
      },
      maybeSingle: async () => ({
        data: state.exists
          ? { deletion_requested_at: state.deleting ? "2026-10-10T00:00:00Z" : null }
          : null,
        error: null,
      }),
      then: (
        resolve: (result: {
          data: Tables<"workspace_resource_operations">[];
          error: Error | null;
        }) => unknown,
      ) => {
        if (table !== "workspace_resource_operations") throw new Error(`Unexpected table ${table}`);
        if (deleting) {
          if (state.reservationDeleteFailure)
            return resolve({ data: [], error: new Error("Lost deletion acknowledgement") });
          if (state.lateSandboxId) {
            state.operations[0]!.resource_id = state.lateSandboxId;
            state.lateSandboxId = null;
          }
          state.operations = state.operations.filter(
            (row) => !filters.every((filter) => filter(row)),
          );
          return resolve({ data: [], error: null });
        }
        return resolve({
          data: state.operations
            .filter((row) => filters.every((filter) => filter(row)))
            .map((row) => ({ ...row })),
          error: null,
        });
      },
    };
    return query;
  };
  const rpc = vi.fn(async (name: string) => {
    if (name !== "finish_workspace_deletion") throw new Error(`Unexpected RPC ${name}`);
    const blocked =
      state.operations.length > 0 ||
      [...state.objects.values()].some((paths) =>
        [...paths].some((path) => path.startsWith(`${workspaceId}/`)),
      );
    if (!blocked) state.exists = false;
    return { data: !blocked, error: null };
  });
  return { admin: { from, rpc, storage } as never, lists, removals, rpc, state };
}

describe("durable workspace deletion", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("drains more than one page including nested prefixes without skipping shifted objects", async () => {
    const f = fixture();
    f.state.objects.set(
      "session-attachments",
      new Set([
        ...Array.from(
          { length: 235 },
          (_, index) => `${workspaceId}/${String(index).padStart(3, "0")}.png`,
        ),
        `${workspaceId}/nested/photo.png`,
        "other-workspace/keep.png",
      ]),
    );
    await removeWorkspaceStoragePrefix(f.admin, "session-attachments", workspaceId);
    expect([...f.state.objects.get("session-attachments")!]).toEqual(["other-workspace/keep.png"]);
    expect(f.removals.flat()).toHaveLength(236);
    expect(f.lists.filter((entry) => entry.prefix === workspaceId)).toHaveLength(4);
  });

  it("retains the workspace on Storage failure and finishes from durable records on retry", async () => {
    const f = fixture();
    f.state.objects.set("workspace-avatars", new Set([`${workspaceId}/avatar.png`]));
    f.state.removeFailure = true;
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Storage unavailable",
    );
    expect(f.state.exists).toBe(true);
    expect(f.rpc).not.toHaveBeenCalled();
    expect([...f.state.objects.get("workspace-avatars")!]).toEqual(["workspace-1/avatar.png"]);
    f.state.removeFailure = false;
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.state.exists).toBe(false);
    expect([...f.state.objects.get("workspace-avatars")!]).toEqual([]);
  });

  it("waits for an unknown acquisition and then stops a late published sandbox", async () => {
    const f = fixture([operation()]);
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(false);
    expect(f.state.exists).toBe(true);
    expect(f.rpc).not.toHaveBeenCalled();
    f.state.operations[0]!.resource_id = "late-sandbox";
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("late-sandbox", {
      connection: { provider: "e2b", revision: "revision-1", credentials: { apiKey: "fixture" } },
      throwOnError: true,
    });
    expect(f.state.operations).toEqual([]);
    expect(f.state.exists).toBe(false);
  });

  it("retains a known sandbox after stop failure even after its recovery deadline", async () => {
    const f = fixture([
      operation({ resource_id: "known-sandbox", recovery_after: "2020-01-01T00:00:00Z" }),
    ]);
    mocked.stopSandboxById.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Provider unavailable",
    );
    expect(f.state.operations[0]?.resource_id).toBe("known-sandbox");
    expect(f.state.exists).toBe(true);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.state.exists).toBe(false);
  });

  it("can repeat a successful provider stop after a crash before deleting the reservation", async () => {
    const f = fixture([operation({ resource_id: "repeat-stop" })]);
    f.state.reservationDeleteFailure = true;
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Lost deletion acknowledgement",
    );
    expect(f.state.operations[0]?.resource_id).toBe("repeat-stop");
    f.state.reservationDeleteFailure = false;
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(mocked.stopSandboxById.mock.calls.map(([id]) => id)).toEqual([
      "repeat-stop",
      "repeat-stop",
    ]);
  });

  it("keeps a late ID that races reclamation of an expired unknown acquisition", async () => {
    const f = fixture([operation({ recovery_after: "2020-01-01T00:00:00Z" })]);
    f.state.lateSandboxId = "racing-sandbox";
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(false);
    expect(f.state.operations[0]?.resource_id).toBe("racing-sandbox");
    expect(f.state.exists).toBe(true);
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith(
      "racing-sandbox",
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it("never cleans up an unfenced workspace", async () => {
    const f = fixture();
    f.state.deleting = false;
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(false);
    expect(mocked.stopWorkspaceProviderSandboxes).not.toHaveBeenCalled();
    expect(f.state.exists).toBe(true);
  });
});
