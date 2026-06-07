import { afterEach, describe, expect, it, vi } from "vitest";

const cancelMocks = vi.hoisted(() => ({
  cancelSessionWork: vi.fn(async () => ({
    canceledJobIds: [] as string[],
    canceledRunIds: [] as string[],
    stoppedSandboxIds: [] as string[],
  })),
}));
vi.mock("@/lib/pipeline/cancel", () => ({
  cancelSessionWork: cancelMocks.cancelSessionWork,
}));

import { archiveSession, unarchiveSession } from "@/lib/pipeline/archive";

type Row = { archived_at: string | null; id: string };

type Call = {
  filters: Record<string, unknown>;
  op: "select" | "update";
  patch?: Record<string, unknown>;
  table: string;
};

/**
 * Admin mock for the `sessions` table supporting both the guarded update
 * (`.update().eq().is()/.not().select().maybeSingle()`) and the idempotent
 * fallback read (`.select().eq().single()`).
 */
function buildAdmin(fixture: { selectRow?: Row; updateRow?: Row | null }) {
  const calls: Call[] = [];

  function makeBuilder(op: Call["op"], table: string, patch?: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        filters[`eq.${col}`] = val;
        return builder;
      },
      is(col: string, val: unknown) {
        filters[`is.${col}`] = val;
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
        calls.push({ filters, op, patch, table });
        return Promise.resolve({ data: fixture.updateRow ?? null, error: null });
      },
      single() {
        calls.push({ filters, op, patch, table });
        return Promise.resolve({ data: fixture.selectRow ?? null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from() {
      return {
        select() {
          return makeBuilder("select", "sessions");
        },
        update(patch: Record<string, unknown>) {
          return makeBuilder("update", "sessions", patch);
        },
      };
    },
  };

  return { admin, calls };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("archiveSession", () => {
  it("sets archived_at under the is-null guard, then cancels in-flight work", async () => {
    const { admin, calls } = buildAdmin({
      updateRow: { archived_at: "2026-06-07T12:00:00.000Z", id: "s1" },
    });

    const result = await archiveSession(admin as never, {
      reason: "Session archived by a workspace member.",
      sessionId: "s1",
    });

    expect(cancelMocks.cancelSessionWork).toHaveBeenCalledWith(admin, {
      parkPhaseStatus: true,
      reason: "Session archived by a workspace member.",
      sessionId: "s1",
    });

    const update = calls.find((c) => c.op === "update");
    expect(typeof update?.patch?.archived_at).toBe("string");
    expect(update?.filters["eq.id"]).toBe("s1");
    expect(update?.filters["is.archived_at"]).toBeNull();

    expect(result).toEqual({ archivedAt: "2026-06-07T12:00:00.000Z", id: "s1" });
    // No fallback read needed when the guarded update matched a row.
    expect(calls.some((c) => c.op === "select")).toBe(false);
  });

  it("is idempotent: when already archived it reads back the current state", async () => {
    const { admin, calls } = buildAdmin({
      updateRow: null,
      selectRow: { archived_at: "2026-06-01T00:00:00.000Z", id: "s1" },
    });

    const result = await archiveSession(admin as never, {
      reason: "Session archived by a workspace member.",
      sessionId: "s1",
    });

    expect(result).toEqual({ archivedAt: "2026-06-01T00:00:00.000Z", id: "s1" });
    expect(calls.some((c) => c.op === "select")).toBe(true);
    // A prior archive already canceled the work; this no-op must not re-cancel.
    expect(cancelMocks.cancelSessionWork).not.toHaveBeenCalled();
  });
});

describe("unarchiveSession", () => {
  it("clears archived_at under the not-null guard without canceling work", async () => {
    const { admin, calls } = buildAdmin({
      updateRow: { archived_at: null, id: "s1" },
    });

    const result = await unarchiveSession(admin as never, { sessionId: "s1" });

    expect(cancelMocks.cancelSessionWork).not.toHaveBeenCalled();

    const update = calls.find((c) => c.op === "update");
    expect(update?.patch).toEqual({ archived_at: null });
    expect(update?.filters["not.archived_at"]).toEqual(["is", null]);

    expect(result).toEqual({ archivedAt: null, id: "s1" });
  });

  it("is idempotent: when already active it reads back the current state", async () => {
    const { admin } = buildAdmin({
      updateRow: null,
      selectRow: { archived_at: null, id: "s1" },
    });

    const result = await unarchiveSession(admin as never, { sessionId: "s1" });

    expect(result).toEqual({ archivedAt: null, id: "s1" });
  });
});
