import { afterEach, describe, expect, it, vi } from "vitest";
import { stopRunSandbox } from "@/lib/pipeline/cancel";
import type { Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({
  loadWorkspaceSandboxConnection: vi.fn().mockResolvedValue({
    connection: { provider: "e2b", revision: "revision-1", credentials: { apiKey: "fixture" } },
  }),
  findSandboxAcquisition: vi.fn().mockResolvedValue([]),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceProviderSandboxes: vi.fn().mockResolvedValue({ stoppedSandboxIds: [] }),
}));
vi.mock("@/lib/sandbox", () => ({
  findSandboxAcquisition: mocked.findSandboxAcquisition,
  stopSandboxById: mocked.stopSandboxById,
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
}));
vi.mock("@/lib/vercel-sandbox/teardown", () => ({
  stopWorkspaceProviderSandboxes: mocked.stopWorkspaceProviderSandboxes,
}));

import {
  removeWorkspaceStoragePrefix,
  resumePendingWorkspaceDeletions,
  resumeWorkspaceDeletion,
} from "./deletion";

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
    cleanupReceiptFailure: false,
    acquisitionSettlementFailure: false,
    cleanupReceipts: [] as Tables<"workspace_sandbox_cleanup_receipts">[],
    lateSandboxId: null as string | null,
    transferBeforeClaim: false,
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
    if (table === "workspace_sandbox_cleanup_receipts") {
      const criteria = new Map<string, string>();
      const receipts = {
        select: () => receipts,
        eq: (column: keyof Tables<"workspace_sandbox_cleanup_receipts">, value: string) => {
          criteria.set(column, value);
          return receipts;
        },
        maybeSingle: async () => ({
          data:
            state.cleanupReceipts.find((row) =>
              Object.entries(row).every(
                ([column, value]) => !criteria.has(column) || criteria.get(column) === value,
              ),
            ) ?? null,
          error: null,
        }),
        upsert: async (
          receipt: Omit<Tables<"workspace_sandbox_cleanup_receipts">, "confirmed_at">,
        ) => {
          if (state.cleanupReceiptFailure)
            return { error: new Error("Could not record cleanup receipt") };
          state.cleanupReceipts.push({ ...receipt, confirmed_at: "2026-10-10T00:00:00Z" });
          return { error: null };
        },
      };
      return receipts;
    }
    let deleting = false;
    let update: Pick<Tables<"workspace_resource_operations">, "settled_at"> | undefined;
    const filters: Array<(row: Tables<"workspace_resource_operations">) => boolean> = [];
    const query = {
      select: () => query,
      order: () => query,
      limit: () => query,
      not: () => query,
      or: (condition: string) => {
        const recoveryTime = Date.parse(condition.split("recovery_after.lte.")[1] ?? "");
        filters.push(
          (row) => row.settled_at !== null || Date.parse(row.recovery_after) <= recoveryTime,
        );
        return query;
      },
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
      update: (patch: Pick<Tables<"workspace_resource_operations">, "settled_at">) => {
        update = patch;
        return query;
      },
      maybeSingle: async () => {
        if (table === "workspace_resource_operations" && update) {
          if (state.transferBeforeClaim) state.operations = [];
          const row = state.operations.find((entry) => filters.every((filter) => filter(entry)));
          if (!row) return { data: null, error: null };
          row.settled_at = update.settled_at;
          return { data: { id: row.id }, error: null };
        }
        return {
          data: state.exists
            ? { deletion_requested_at: state.deleting ? "2026-10-10T00:00:00Z" : null }
            : null,
          error: null,
        };
      },
      then: (
        resolve: (result: {
          data: Tables<"workspace_resource_operations">[];
          error: Error | null;
        }) => unknown,
      ) => {
        if (table === "workspaces" && !state.deleting) return resolve({ data: [], error: null });
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
    if (name === "settle_factory_workflow_sandbox_acquisition")
      return { data: !state.acquisitionSettlementFailure, error: null };
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
    mocked.loadWorkspaceSandboxConnection.mockReset().mockResolvedValue({
      connection: { provider: "e2b", revision: "revision-1", credentials: { apiKey: "fixture" } },
    });
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

  it.each([
    "session-validation-evidence",
    "workspace-run-exports",
    "factory-workflow-usage-recovery",
  ])("cleans private %s objects without deleting another workspace", async (bucket) => {
    const f = fixture();
    f.state.objects.set(
      bucket,
      new Set([`${workspaceId}/run/report`, "other-workspace/run/report"]),
    );
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect([...f.state.objects.get(bucket)!]).toEqual(["other-workspace/run/report"]);
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

  it("recovers a lost create response by immutable acquisition identity after its horizon", async () => {
    const f = fixture([operation({ connection_revision: "revision-1" })]);
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(false);
    expect(mocked.findSandboxAcquisition).not.toHaveBeenCalled();
    expect(f.state.operations).toHaveLength(1);

    f.state.operations[0]!.recovery_after = "2020-01-01T00:00:00Z";
    mocked.findSandboxAcquisition.mockResolvedValueOnce(["recovered-sandbox"]);
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(mocked.findSandboxAcquisition).toHaveBeenCalledWith(
      { operationId: "operation-1", workspaceId },
      expect.objectContaining({ provider: "e2b", revision: "revision-1" }),
    );
    expect(mocked.stopSandboxById).toHaveBeenCalledWith(
      "recovered-sandbox",
      expect.objectContaining({ throwOnError: true }),
    );
    expect(f.state.cleanupReceipts).toEqual([
      {
        workspace_id: workspaceId,
        provider: "e2b",
        connection_revision: "revision-1",
        sandbox_id: "recovered-sandbox",
        confirmed_at: "2026-10-10T00:00:00Z",
      },
    ]);
    expect(f.rpc).toHaveBeenCalledWith("settle_factory_workflow_sandbox_acquisition", {
      p_operation_id: "operation-1",
      p_stopped_sandbox_ids: ["recovered-sandbox"],
    });
    expect(f.state.operations).toEqual([]);
  });

  it("keeps the acquisition reservation until its workflow proof is reconciled", async () => {
    const f = fixture([
      operation({ resource_id: "recovered-sandbox", connection_revision: "revision-1" }),
    ]);
    f.state.acquisitionSettlementFailure = true;
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Could not reconcile workflow sandbox acquisition.",
    );
    expect(f.state.cleanupReceipts).toEqual([
      expect.objectContaining({ sandbox_id: "recovered-sandbox" }),
    ]);
    expect(f.state.operations).toHaveLength(1);

    f.state.acquisitionSettlementFailure = false;
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.state.operations).toEqual([]);
  });

  it("keeps the credential fence until confirmed stop is durably reusable", async () => {
    const f = fixture([
      operation({ resource_id: "late-workflow-sandbox", connection_revision: "revision-1" }),
    ]);
    f.state.cleanupReceiptFailure = true;
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Could not record cleanup receipt",
    );
    expect(mocked.stopSandboxById).toHaveBeenCalledOnce();
    expect(f.state.operations).toHaveLength(1);
    expect(f.state.cleanupReceipts).toEqual([]);

    f.state.cleanupReceiptFailure = false;
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.state.cleanupReceipts).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        provider: "e2b",
        connection_revision: "revision-1",
        sandbox_id: "late-workflow-sandbox",
      }),
    ]);
    expect(f.state.operations).toEqual([]);
  });

  it("lets the workflow drain reuse a late-handle confirmation after workspace credentials rotate", async () => {
    const f = fixture([
      operation({
        resource_id: "late-workflow-sandbox",
        connection_revision: "revision-1",
        settled_at: "2026-10-10T00:00:00Z",
      }),
    ]);
    f.state.deleting = false;
    await resumePendingWorkspaceDeletions(f.admin);
    expect(f.state.operations).toEqual([]);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);

    mocked.loadWorkspaceSandboxConnection.mockResolvedValueOnce({
      connection: {
        provider: "e2b",
        revision: "revision-2",
        credentials: { apiKey: "replacement" },
      },
    });
    await expect(
      stopRunSandbox(
        f.admin,
        {
          id: "retired-run",
          workspace_id: workspaceId,
          sandbox_id: "late-workflow-sandbox",
          sandbox_provider: "e2b",
          sandbox_connection_revision: "revision-1",
          sandbox_vercel_project_id: null,
          sandbox_vercel_team_id: null,
        },
        undefined,
        { throwOnError: true },
      ),
    ).resolves.toBe(true);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);
    expect(mocked.loadWorkspaceSandboxConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials available on lookup failure and creates no stop after a verified empty lookup", async () => {
    const f = fixture([
      operation({
        connection_revision: "revision-1",
        recovery_after: "2020-01-01T00:00:00Z",
      }),
    ]);
    mocked.findSandboxAcquisition.mockRejectedValueOnce(new Error("Provider lookup unavailable"));
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Provider lookup unavailable",
    );
    expect(f.state.operations).toHaveLength(1);
    expect(f.state.exists).toBe(true);

    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.state.operations).toEqual([]);
    expect(f.state.cleanupReceipts).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
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

  describe.each([
    {
      bucket: "session-source-checkpoints",
      path: `${workspaceId}/11111111-1111-4111-8111-111111111111-retry-1-22222222-2222-4222-8222-222222222222.bundle`,
    },
    {
      bucket: "session-source-checkpoints",
      path: `${workspaceId}/benchmark/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/${"a".repeat(64)}.bundle`,
    },
    {
      bucket: "session-validation-evidence",
      path: `${workspaceId}/11111111-1111-4111-8111-111111111111/browser/22222222-2222-4222-8222-222222222222.png`,
    },
    {
      bucket: "session-validation-evidence",
      path: `${workspaceId}/11111111-1111-4111-8111-111111111111/browser/22222222-2222-4222-8222-222222222222.webm`,
    },
  ])("upload recovery in $bucket", ({ bucket, path }) => {
    it.each(["abandoned", "transferred"] as const)(
      "reconciles a stale upload reservation when the object was %s",
      async (outcome) => {
        const f = fixture([
          operation({
            kind: "upload",
            provider: null,
            resource_id: path,
            storage_bucket: bucket,
            recovery_after: "2020-01-01T00:00:00Z",
          }),
        ]);
        f.state.deleting = false;
        f.state.transferBeforeClaim = outcome === "transferred";
        f.state.objects.set(bucket, new Set([path]));

        await resumePendingWorkspaceDeletions(f.admin);

        expect(f.state.operations).toEqual([]);
        expect(f.state.objects.get(bucket)?.has(path)).toBe(outcome === "transferred");
        expect(f.removals.flat()).toEqual(outcome === "transferred" ? [] : [path]);
      },
    );
  });
});
