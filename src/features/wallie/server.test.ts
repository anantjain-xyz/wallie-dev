import { describe, expect, it, vi } from "vitest";

import { loadWallieRunPage, WALLIE_RUN_PAGE_SIZE } from "@/features/wallie/server";

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function row(index: number) {
  return {
    created_at: "2026-07-18T12:00:00.000Z",
    finished_at: "2026-07-18T12:01:00.000Z",
    id: uuid(index),
    model_name: "gpt-5",
    model_provider: "codex",
    run_type: "code" as const,
    stage_id: null,
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
});
