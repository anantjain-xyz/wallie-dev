import { afterEach, describe, expect, it, vi } from "vitest";

const cancelMocks = vi.hoisted(() => ({
  cleanupSessionWorkReceipt: vi.fn(async () => ({
    canceledJobIds: [] as string[],
    canceledRunIds: [] as string[],
    stoppedSandboxIds: [] as string[],
  })),
}));
vi.mock("@/lib/pipeline/cancel", () => ({
  cleanupSessionWorkReceipt: cancelMocks.cleanupSessionWorkReceipt,
}));
import { archiveSession, unarchiveSession } from "@/lib/pipeline/archive";

type Row = {
  archived_at: string | null;
  id: string;
  phase_status: "in_progress" | "approved" | "awaiting_review" | "rejected";
  updated_at: string;
};
type Call = {
  filters: Record<string, unknown>;
  op: "select" | "update";
  patch?: Record<string, unknown>;
  table: string;
};

function buildAdmin(fixture: { selectRow?: Row; updateRow?: Row | null }) {
  const calls: Call[] = [];
  const rpc = vi.fn(async () => ({
    data: [{ job_ids: ["job-1"], run_ids: ["run-1"] }],
    error: null as { message: string } | null,
  }));
  function makeBuilder(op: Call["op"], patch?: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[`eq.${col}`] = val;
        return builder;
      },
      not(col: string, operator: string, val: unknown) {
        filters[`not.${col}`] = [operator, val];
        return builder;
      },
      select() {
        return builder;
      },
      maybeSingle() {
        calls.push({ filters, op, patch, table: "sessions" });
        return Promise.resolve({ data: fixture.updateRow ?? null, error: null });
      },
      single() {
        calls.push({ filters, op, patch, table: "sessions" });
        return Promise.resolve({ data: fixture.selectRow ?? null, error: null });
      },
    };
    return builder;
  }
  const admin = {
    rpc,
    from() {
      return {
        select: () => makeBuilder("select"),
        update: (patch: Record<string, unknown>) => makeBuilder("update", patch),
      };
    },
  };
  return { admin, calls, rpc };
}

afterEach(() => {
  vi.clearAllMocks();
});
const input = {
  reason: "Session archived by a workspace member.",
  sessionId: "s1",
  workspaceId: "w1",
};

describe("archiveSession", () => {
  it.each(["awaiting_review", "approved", "rejected"] as const)(
    "preserves the RPC's %s phase without an application-side phase write",
    async (phase) => {
      const { admin, calls, rpc } = buildAdmin({
        selectRow: {
          archived_at: "2026-06-07T12:00:00.000Z",
          id: "s1",
          phase_status: phase,
          updated_at: "2026-06-07T12:00:00.000Z",
        },
      });
      const result = await archiveSession(admin as never, input);
      expect(rpc).toHaveBeenCalledExactlyOnceWith("archive_session_job_attempts", {
        p_completed: false,
        p_reason: input.reason,
        p_session_id: "s1",
        p_workspace_id: "w1",
      });
      expect(cancelMocks.cleanupSessionWorkReceipt).toHaveBeenCalledExactlyOnceWith(admin, {
        receipt: { job_ids: ["job-1"], run_ids: ["run-1"] },
        reason: input.reason,
        workspaceId: "w1",
      });
      expect(result.phaseStatus).toBe(phase);
      expect(calls).toEqual([
        {
          table: "sessions",
          op: "select",
          patch: undefined,
          filters: { "eq.id": "s1", "eq.workspace_id": "w1" },
        },
      ]);
    },
  );

  it("commits archive before cleanup and reads later state without overwriting a concurrent unarchive", async () => {
    const row: Row = {
      archived_at: "2026-06-07T12:00:00.000Z",
      id: "s1",
      phase_status: "rejected",
      updated_at: "2026-06-07T12:00:00.000Z",
    };
    const { admin, calls, rpc } = buildAdmin({ selectRow: row });
    cancelMocks.cleanupSessionWorkReceipt.mockImplementationOnce(async () => {
      expect(rpc).toHaveBeenCalledTimes(1);
      // Another request can unarchive and launch a replacement while the old
      // sandbox stop is waiting. The archive helper must not park it afterward.
      row.archived_at = null;
      row.phase_status = "in_progress";
      return { canceledJobIds: ["job-1"], canceledRunIds: ["run-1"], stoppedSandboxIds: ["sb-1"] };
    });
    const result = await archiveSession(admin as never, input);
    expect(result).toMatchObject({ archivedAt: null, phaseStatus: "in_progress" });
    expect(calls.some((call) => call.op === "update")).toBe(false);
  });

  it("lets an explicit completion archive approve inside the transaction", async () => {
    const { admin, rpc } = buildAdmin({
      selectRow: {
        archived_at: "2026-06-07T12:00:00.000Z",
        id: "s1",
        phase_status: "approved",
        updated_at: "2026-06-07T12:00:00.000Z",
      },
    });
    await archiveSession(admin as never, { ...input, completed: true });
    expect(rpc).toHaveBeenCalledWith(
      "archive_session_job_attempts",
      expect.objectContaining({ p_completed: true }),
    );
  });

  it("does not clean up or rewrite state if the archive transaction fails", async () => {
    const { admin, calls, rpc } = buildAdmin({});
    rpc.mockResolvedValueOnce({ data: [], error: { message: "archive failed" } });
    await expect(archiveSession(admin as never, input)).rejects.toEqual({
      message: "archive failed",
    });
    expect(cancelMocks.cleanupSessionWorkReceipt).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("unarchiveSession", () => {
  it("clears archived_at under the not-null guard without canceling work", async () => {
    const { admin, calls } = buildAdmin({
      selectRow: {
        archived_at: null,
        id: "s1",
        phase_status: "rejected",
        updated_at: "2026-06-07T12:00:01.000Z",
      },
      updateRow: {
        archived_at: null,
        id: "s1",
        phase_status: "rejected",
        updated_at: "2026-06-07T12:00:00.000Z",
      },
    });

    const result = await unarchiveSession(admin as never, { sessionId: "s1", workspaceId: "w1" });

    expect(cancelMocks.cleanupSessionWorkReceipt).not.toHaveBeenCalled();

    const update = calls.find((c) => c.op === "update");
    expect(update?.patch).toEqual({ archived_at: null });
    expect(update?.filters["not.archived_at"]).toEqual(["is", null]);

    expect(result).toEqual({
      archivedAt: null,
      id: "s1",
      phaseStatus: "rejected",
      updatedAt: "2026-06-07T12:00:01.000Z",
    });
  });

  it("is idempotent: when already active it reads back the current state", async () => {
    const { admin } = buildAdmin({
      updateRow: null,
      selectRow: {
        archived_at: null,
        id: "s1",
        phase_status: "awaiting_review",
        updated_at: "2026-06-07T12:00:00.000Z",
      },
    });

    const result = await unarchiveSession(admin as never, { sessionId: "s1", workspaceId: "w1" });

    expect(result).toEqual({
      archivedAt: null,
      id: "s1",
      phaseStatus: "awaiting_review",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });
  });

  it("only clears the archive version that created an Undo action", async () => {
    const expectedArchivedAt = "2026-06-07T12:00:00.000Z";
    const newerArchivedAt = "2026-06-07T13:00:00.000Z";
    const { admin, calls } = buildAdmin({
      updateRow: null,
      selectRow: {
        archived_at: newerArchivedAt,
        id: "s1",
        phase_status: "awaiting_review",
        updated_at: newerArchivedAt,
      },
    });

    const result = await unarchiveSession(admin as never, {
      expectedArchivedAt,
      sessionId: "s1",
      workspaceId: "w1",
    });

    const update = calls.find((call) => call.op === "update");
    expect(update?.filters["eq.archived_at"]).toBe(expectedArchivedAt);
    expect(update?.filters["not.archived_at"]).toBeUndefined();
    expect(result.archivedAt).toBe(newerArchivedAt);
  });
});
