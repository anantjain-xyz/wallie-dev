import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConnection } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({ hasRecoverableSandboxSource: vi.fn() }));
vi.mock("@/lib/sandbox", () => mocked);
import { hasRetainedSandboxSource } from "./run-cleanup-ownership";

type Row = Record<string, unknown>;
function fixture(provider: SandboxConnection["provider"] = "e2b") {
  const connection = { provider, revision: "revision-1", credentials: {} } as SandboxConnection;
  const owner: Row = {
    id: "run-1",
    sandbox_id: "sandbox-1",
    status: "error",
    source_recovery_required: true,
    workspace_id: "workspace-1",
    sandbox_provider: provider,
    sandbox_connection_revision: "revision-1",
  };
  const rows = [owner];
  const state = { readErrorAt: 0, writeError: false, reads: 0, writes: 0 };
  const from = () => {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | undefined;
    const query = {
      select: () => query,
      update: (value: Row) => {
        patch = value;
        return query;
      },
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      then: (resolve: (value: { data: Row[] | null; error: Error | null }) => void) => {
        const matched = rows.filter((row) => filters.every((filter) => filter(row)));
        if (patch) {
          state.writes++;
          if (state.writeError)
            return resolve({ data: null, error: new Error("Write unavailable") });
          matched.forEach((row) => Object.assign(row, patch));
        } else {
          state.reads++;
          if (state.readErrorAt === state.reads)
            return resolve({ data: null, error: new Error("Read unavailable") });
        }
        resolve({ data: matched.map((row) => ({ ...row })), error: null });
      },
    };
    return query;
  };
  return {
    owner,
    rows,
    state,
    check: () =>
      hasRetainedSandboxSource({ from } as never, { connection, workspaceId: "workspace-1" }),
  };
}

beforeEach(() => {
  mocked.hasRecoverableSandboxSource.mockReset().mockResolvedValue(false);
});

describe("retained source ownership", () => {
  it.each(["vercel", "e2b", "daytona"] as const)(
    "clears a %s marker only after confirmed absence",
    async (provider) => {
      const f = fixture(provider);
      expect(await f.check()).toBe(false);
      expect(f.owner.source_recovery_required).toBe(false);
      expect(f.owner.sandbox_id).toBe("sandbox-1");
      expect(f.state.reads).toBe(2);
      expect(await f.check()).toBe(false);
      expect(mocked.hasRecoverableSandboxSource).toHaveBeenCalledOnce();
    },
  );
  it("keeps recoverable source regardless of how old the failed run is", async () => {
    const f = fixture();
    f.owner.completed_at = "2000-01-01T00:00:00Z";
    mocked.hasRecoverableSandboxSource.mockResolvedValue(true);
    expect(await f.check()).toBe(true);
    expect(f.state.writes).toBe(0);
  });
  it("keeps the marker when provider verification fails", async () => {
    const f = fixture();
    mocked.hasRecoverableSandboxSource.mockRejectedValue(new Error("Provider unavailable"));
    await expect(f.check()).rejects.toThrow("Provider unavailable");
    expect(f.owner.source_recovery_required).toBe(true);
    expect(f.state.writes).toBe(0);
  });
  it.each([null, "provisioning:run-1"])(
    "retains unverified sandbox identity %s",
    async (sandboxId) => {
      const f = fixture();
      f.owner.sandbox_id = sandboxId;
      expect(await f.check()).toBe(true);
      expect(mocked.hasRecoverableSandboxSource).not.toHaveBeenCalled();
    },
  );
  it.each(["queued", "started", "running", "unknown"])(
    "does not release a %s owner",
    async (status) => {
      const f = fixture();
      f.owner.status = status;
      expect(await f.check()).toBe(true);
      expect(mocked.hasRecoverableSandboxSource).not.toHaveBeenCalled();
    },
  );
  it.each(["sandbox_id", "status"])(
    "retains an owner whose %s changed during verification",
    async (key) => {
      const f = fixture();
      mocked.hasRecoverableSandboxSource.mockImplementation(async () => {
        f.owner[key] = key === "status" ? "running" : "new-sandbox";
        return false;
      });
      expect(await f.check()).toBe(true);
      expect(f.owner.source_recovery_required).toBe(true);
    },
  );
  it("does not clear another connection or workspace with the same sandbox ID", async () => {
    const f = fixture();
    const others: Row[] = [
      { ...f.owner, id: "run-2", workspace_id: "workspace-other" },
      { ...f.owner, id: "run-3", sandbox_provider: "daytona" },
      { ...f.owner, id: "run-4", sandbox_connection_revision: "revision-other" },
    ];
    f.rows.push(...others);
    expect(await f.check()).toBe(false);
    expect(others.every((row) => row.source_recovery_required)).toBe(true);
  });
  it("retains a newly recorded owner discovered by the final read", async () => {
    const f = fixture();
    mocked.hasRecoverableSandboxSource.mockImplementation(async () => {
      f.rows.push({ ...f.owner, id: "run-2", sandbox_id: "new-sandbox" });
      return false;
    });
    expect(await f.check()).toBe(true);
    expect(f.rows[1]!.source_recovery_required).toBe(true);
  });
  it.each([1, 2])("fails closed on ownership read %s", async (readErrorAt) => {
    const f = fixture();
    f.state.readErrorAt = readErrorAt;
    await expect(f.check()).rejects.toThrow("Read unavailable");
  });
  it("fails closed when the absence cannot be persisted", async () => {
    const f = fixture();
    f.state.writeError = true;
    await expect(f.check()).rejects.toThrow("Write unavailable");
    expect(f.owner.source_recovery_required).toBe(true);
  });
});
