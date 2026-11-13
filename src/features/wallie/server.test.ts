import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Enums } from "@/lib/supabase/database.types";

const adminOrdinalRows: Array<{
  created_at: string;
  id: string;
  stage_id: string | null;
}> = [];
const adminRangeCalls: Array<{ from: number; to: number }> = [];
const createSupabaseAdminClientMock = vi.fn(() => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        order: () => ({
          order: () => ({
            range: async (from: number, to: number) => {
              adminRangeCalls.push({ from, to });
              return {
                data: adminOrdinalRows.slice(from, to + 1),
                error: null,
              };
            },
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => createSupabaseAdminClientMock(),
}));

import {
  ATTEMPT_ORDINAL_PAGE_SIZE,
  computeAttemptOrdinalsFromRows,
  loadWallieRunPage,
  mapWallieSandboxConnectionStatus,
  WALLIE_RUN_PAGE_SIZE,
} from "@/features/wallie/server";

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function row(index: number, overrides: Partial<ReturnType<typeof baseRow>> = {}) {
  return {
    ...baseRow(index),
    ...overrides,
  };
}

function baseRow(index: number, status: Enums<"agent_run_status"> = "success") {
  return {
    branch_name: null as string | null,
    created_at: "2026-07-18T12:00:00.000Z",
    finished_at: "2026-07-18T12:01:00.000Z",
    id: uuid(index),
    model_name: "gpt-5",
    model_provider: "codex",
    run_type: "code" as const,
    stage_id: null as string | null,
    stage_name: "Build",
    stage_slug: "build",
    started_at: "2026-07-18T12:00:10.000Z",
    status,
    triggered_by_member_id: null,
    updated_at: "2026-07-18T12:01:00.000Z",
  };
}

function client(
  rows: ReturnType<typeof row>[],
  failures: Array<{
    agent_run_id: string;
    created_at: string;
    id: string;
    kind: string;
    message_md: string;
  }> = [],
  failureError: { message: string } | null = null,
) {
  const query = {
    eq: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
    then: (resolve: (value: { data: typeof rows; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.or.mockReturnValue(query);

  const failureQuery = {
    eq: vi.fn(),
    in: vi.fn(),
    select: vi.fn(),
    then: (resolve: (value: { data: typeof failures; error: typeof failureError }) => void) =>
      resolve({ data: failures, error: failureError }),
  };
  failureQuery.select.mockReturnValue(failureQuery);
  failureQuery.in.mockReturnValue(failureQuery);
  failureQuery.eq.mockReturnValue(failureQuery);

  return {
    query,
    failureQuery,
    supabase: {
      from: vi.fn((table: string) => (table === "agent_run_messages" ? failureQuery : query)),
    },
  };
}

beforeEach(() => {
  adminOrdinalRows.length = 0;
  adminRangeCalls.length = 0;
  createSupabaseAdminClientMock.mockClear();
});

describe("computeAttemptOrdinalsFromRows", () => {
  it("sorts a copy ascending by created_at then id and keys by stage_id or __session__", () => {
    const input = [
      { created_at: "2026-07-18T12:05:00.000Z", id: uuid(3), stage_id: "stage-build" },
      { created_at: "2026-07-18T12:00:00.000Z", id: uuid(2), stage_id: "stage-build" },
      { created_at: "2026-07-18T12:00:00.000Z", id: uuid(1), stage_id: "stage-build" },
      { created_at: "2026-07-18T12:01:00.000Z", id: uuid(4), stage_id: null },
      { created_at: "2026-07-18T12:02:00.000Z", id: uuid(5), stage_id: null },
      { created_at: "2026-07-18T11:59:00.000Z", id: uuid(6), stage_id: "stage-plan" },
    ];
    const snapshot = input.map((entry) => entry.id);

    const ordinals = computeAttemptOrdinalsFromRows(input);

    expect(input.map((entry) => entry.id)).toEqual(snapshot);
    expect(ordinals.get(uuid(6))).toBe(1);
    expect(ordinals.get(uuid(1))).toBe(1);
    expect(ordinals.get(uuid(2))).toBe(2);
    expect(ordinals.get(uuid(3))).toBe(3);
    expect(ordinals.get(uuid(4))).toBe(1);
    expect(ordinals.get(uuid(5))).toBe(2);
  });
});

describe("loadWallieRunPage", () => {
  it("loads terminal causes for failed page rows without loading activity", async () => {
    const { failureQuery, supabase } = client(
      [row(3, { status: "error" }), row(2), row(1, { status: "error" })],
      [
        {
          agent_run_id: uuid(3),
          created_at: "2026-07-18T12:01:00.000Z",
          id: "terminal-3",
          kind: "run_failure",
          message_md: JSON.stringify({
            version: 1,
            category: "configuration",
            code: "credentials",
            diagnostic: "API_KEY=must-not-reach-client",
          }),
        },
      ],
    );
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(failureQuery.in).toHaveBeenCalledWith("agent_run_id", [uuid(3), uuid(1)]);
    expect(failureQuery.eq).toHaveBeenCalledWith("kind", "run_failure");
    expect(page.runs[0]?.failure).toMatchObject({
      category: "configuration",
      code: "credentials",
      cause: expect.stringContaining("credentials"),
    });
    expect(page.runs.find((run) => run.id === uuid(1))?.failure).toBeNull();
    expect(page.runs.every((run) => run.messages.length === 0)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("must-not-reach-client");
  });

  it("does not fetch activity metadata for successful runs", async () => {
    const { supabase } = client([row(1)]);
    await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });
    expect(supabase.from).not.toHaveBeenCalledWith("agent_run_messages");
  });

  it("surfaces a terminal-record read failure instead of claiming historical data is absent", async () => {
    const error = { message: "terminal records unavailable" };
    const { supabase } = client([row(1, { status: "error" })], [], error);
    await expect(
      loadWallieRunPage({
        memberIndex: new Map(),
        sessionId: uuid(999),
        supabase: supabase as never,
      }),
    ).rejects.toEqual(error);
  });

  it("selects and returns the recorded branch after a stage slug changes", async () => {
    const branch = "wallie/build-session-1-job-job-1-attempt-2";
    const { query, supabase } = client([row(1, { branch_name: branch, stage_slug: "renamed" })]);
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("branch_name"));
    expect(page.runs[0]?.branchName).toBe(branch);
  });

  it("caps a 200-run scale fixture at 20 metadata rows and zero messages", async () => {
    const fixture = Array.from({ length: 200 }, (_, index) => row(200 - index));
    const { query, supabase } = client(fixture.slice(0, WALLIE_RUN_PAGE_SIZE + 1));
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(query.limit).toHaveBeenCalledWith(21);
    expect(page.runs).toHaveLength(20);
    expect(page.runs.every((run) => run.messages.length === 0)).toBe(true);
    expect(page.nextCursor).toEqual({
      createdAt: fixture[19]?.created_at,
      id: fixture[19]?.id,
    });
  });

  it("uses both tied cursor fields so adjacent pages cannot overlap", async () => {
    const { query, supabase } = client([row(4), row(3)]);
    const cursor = { createdAt: "2026-07-18T12:00:00.000Z", id: uuid(5) };

    await loadWallieRunPage({
      cursor,
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(query.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(query.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(query.or).toHaveBeenCalledWith(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  });

  it("computes first-page attempt ordinals without calling createSupabaseAdminClient across stage slug renames", async () => {
    const first = row(1, {
      created_at: "2026-07-18T12:00:00.000Z",
      stage_id: "stage-stable",
      stage_slug: "build",
    });
    const renamed = row(2, {
      created_at: "2026-07-18T12:05:00.000Z",
      stage_id: "stage-stable",
      stage_name: "Implement",
      stage_slug: "implement",
    });

    const { supabase } = client([renamed, first]);
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled();
    expect(adminRangeCalls).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.runs.find((run) => run.id === first.id)?.attemptCount).toBe(1);
    expect(page.runs.find((run) => run.id === renamed.id)?.attemptCount).toBe(2);
  });

  it("skips createSupabaseAdminClient when first page has exactly WALLIE_RUN_PAGE_SIZE rows", async () => {
    const exactPage = Array.from({ length: WALLIE_RUN_PAGE_SIZE }, (_, index) => {
      const chronologicalIndex = WALLIE_RUN_PAGE_SIZE - index;
      return row(chronologicalIndex, {
        created_at: new Date(
          Date.parse("2026-07-18T12:00:00.000Z") + chronologicalIndex * 60_000,
        ).toISOString(),
        stage_id: chronologicalIndex % 2 === 0 ? "stage-build" : null,
      });
    });

    const { supabase } = client(exactPage);
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled();
    expect(adminRangeCalls).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.runs).toHaveLength(WALLIE_RUN_PAGE_SIZE);
    expect(page.runs[0]?.attemptCount).toBe(WALLIE_RUN_PAGE_SIZE / 2);
    expect(page.runs.at(-1)?.attemptCount).toBe(1);
  });

  it("uses loadAttemptOrdinalsByRunId via createSupabaseAdminClient when first page overflows WALLIE_RUN_PAGE_SIZE", async () => {
    const totalRuns = WALLIE_RUN_PAGE_SIZE + 5;
    const allRuns = Array.from({ length: totalRuns }, (_, index) => {
      const chronologicalIndex = totalRuns - index;
      return row(chronologicalIndex, {
        created_at: new Date(
          Date.parse("2026-07-18T12:00:00.000Z") + chronologicalIndex * 60_000,
        ).toISOString(),
        stage_id: "stage-build",
      });
    });
    adminOrdinalRows.push(
      ...[...allRuns].reverse().map((entry) => ({
        created_at: entry.created_at,
        id: entry.id,
        stage_id: entry.stage_id,
      })),
    );

    const { supabase } = client(allRuns.slice(0, WALLIE_RUN_PAGE_SIZE + 1));
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(createSupabaseAdminClientMock).toHaveBeenCalledTimes(1);
    expect(adminRangeCalls).toEqual([{ from: 0, to: ATTEMPT_ORDINAL_PAGE_SIZE - 1 }]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.runs[0]?.attemptCount).toBe(totalRuns);
  });

  it("uses loadAttemptOrdinalsByRunId via createSupabaseAdminClient when cursor is set", async () => {
    const totalRuns = 5;
    const allRuns = Array.from({ length: totalRuns }, (_, index) => {
      const chronologicalIndex = totalRuns - index;
      return row(chronologicalIndex, {
        created_at: new Date(
          Date.parse("2026-07-18T12:00:00.000Z") + chronologicalIndex * 60_000,
        ).toISOString(),
        stage_id: "stage-build",
      });
    });
    adminOrdinalRows.push(
      ...[...allRuns].reverse().map((entry) => ({
        created_at: entry.created_at,
        id: entry.id,
        stage_id: entry.stage_id,
      })),
    );

    const cursorRun = allRuns[2]!;
    const { supabase } = client(allRuns.slice(3));
    const page = await loadWallieRunPage({
      cursor: { createdAt: cursorRun.created_at, id: cursorRun.id },
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(createSupabaseAdminClientMock).toHaveBeenCalledTimes(1);
    expect(adminRangeCalls).toEqual([{ from: 0, to: ATTEMPT_ORDINAL_PAGE_SIZE - 1 }]);
    expect(page.runs.map((run) => run.attemptCount)).toEqual([2, 1]);
  });

  it("pages attempt-ordinal history past the PostgREST max_rows cap", async () => {
    const history = Array.from({ length: ATTEMPT_ORDINAL_PAGE_SIZE + 3 }, (_, index) => {
      const created = new Date(
        Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000,
      ).toISOString();
      return {
        created_at: created,
        id: uuid(index + 1),
        stage_id: "stage-build",
      };
    });
    adminOrdinalRows.push(...history);

    const newest = row(ATTEMPT_ORDINAL_PAGE_SIZE + 3, {
      created_at: history.at(-1)!.created_at,
      id: history.at(-1)!.id,
      stage_id: "stage-build",
      stage_slug: "build",
    });
    const { supabase } = client([newest]);
    const page = await loadWallieRunPage({
      cursor: { createdAt: "2026-12-31T00:00:00.000Z", id: uuid(9999) },
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(createSupabaseAdminClientMock).toHaveBeenCalledTimes(1);
    expect(adminRangeCalls).toEqual([
      { from: 0, to: ATTEMPT_ORDINAL_PAGE_SIZE - 1 },
      { from: ATTEMPT_ORDINAL_PAGE_SIZE, to: ATTEMPT_ORDINAL_PAGE_SIZE * 2 - 1 },
    ]);
    expect(page.runs.find((run) => run.id === newest.id)?.attemptCount).toBe(
      ATTEMPT_ORDINAL_PAGE_SIZE + 3,
    );
  });
});

describe("mapWallieSandboxConnectionStatus", () => {
  it("blocks a retained active provider disabled by deployment rollout", () => {
    expect(
      mapWallieSandboxConnectionStatus({
        activeProvider: "e2b",
        connections: {
          daytona: null,
          e2b: {
            apiKeyPreview: "e2b_…1234",
            connectionRevision: "revision-e2b",
            lastValidatedAt: "2026-07-22T00:00:00.000Z",
            lastValidationError: null,
            status: "connected",
            updatedAt: "2026-07-22T00:00:00.000Z",
            workspaceId: "workspace-1",
          },
          vercel: null,
        },
        enabledProviders: ["vercel"],
        revision: 2,
        updatedAt: "2026-07-22T00:00:00.000Z",
      }),
    ).toMatchObject({
      connected: false,
      lastValidationError:
        "E2B is disabled in this Wallie deployment. Switch to an enabled sandbox provider.",
      provider: "e2b",
      status: "error",
    });
  });
});
