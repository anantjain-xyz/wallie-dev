import { beforeEach, describe, expect, it, vi } from "vitest";

const adminOrdinalRows: Array<{
  created_at: string;
  id: string;
  stage_id: string | null;
}> = [];
const adminRangeCalls: Array<{ from: number; to: number }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
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
  }),
}));

import {
  ATTEMPT_ORDINAL_PAGE_SIZE,
  loadWallieRunPage,
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

function baseRow(index: number) {
  return {
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
    status: "success" as const,
    triggered_by_member_id: null,
    updated_at: "2026-07-18T12:01:00.000Z",
  };
}

function client(rows: ReturnType<typeof row>[]) {
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

  return { query, supabase: { from: vi.fn(() => query) } };
}

beforeEach(() => {
  adminOrdinalRows.length = 0;
  adminRangeCalls.length = 0;
});

describe("loadWallieRunPage", () => {
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

  it("keys attempt ordinals by stage_id across slug renames", async () => {
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
    adminOrdinalRows.push(
      { created_at: first.created_at, id: first.id, stage_id: first.stage_id },
      { created_at: renamed.created_at, id: renamed.id, stage_id: renamed.stage_id },
    );

    const { supabase } = client([renamed, first]);
    const page = await loadWallieRunPage({
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(page.runs.find((run) => run.id === first.id)?.attemptCount).toBe(1);
    expect(page.runs.find((run) => run.id === renamed.id)?.attemptCount).toBe(2);
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
      memberIndex: new Map(),
      sessionId: uuid(999),
      supabase: supabase as never,
    });

    expect(adminRangeCalls).toEqual([
      { from: 0, to: ATTEMPT_ORDINAL_PAGE_SIZE - 1 },
      { from: ATTEMPT_ORDINAL_PAGE_SIZE, to: ATTEMPT_ORDINAL_PAGE_SIZE * 2 - 1 },
    ]);
    expect(page.runs.find((run) => run.id === newest.id)?.attemptCount).toBe(
      ATTEMPT_ORDINAL_PAGE_SIZE + 3,
    );
  });
});
