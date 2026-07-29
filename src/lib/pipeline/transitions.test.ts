import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  cancelSessionAgentJobs,
  claimSessionForGeneration,
  claimSessionRejection,
  publishRejectedSession,
} from "./transitions";

type RecordedQuery = {
  filters: Array<[method: string, column: string, value: unknown]>;
  patch?: Record<string, unknown>;
  select?: string;
  table: string;
};

function createAdmin(response: { data: unknown; error: { message: string } | null }) {
  const queries: RecordedQuery[] = [];
  const from = vi.fn((table: string) => {
    const record: RecordedQuery = { filters: [], table };
    queries.push(record);
    const builder = {
      eq(column: string, value: unknown) {
        record.filters.push(["eq", column, value]);
        return builder;
      },
      in(column: string, value: unknown) {
        record.filters.push(["in", column, value]);
        return builder;
      },
      is(column: string, value: unknown) {
        record.filters.push(["is", column, value]);
        return builder;
      },
      maybeSingle: vi.fn(async () => response),
      select(columns: string) {
        record.select = columns;
        return builder;
      },
      then(resolve: (value: typeof response) => unknown) {
        return Promise.resolve(response).then(resolve);
      },
      update(patch: Record<string, unknown>) {
        record.patch = patch;
        return builder;
      },
    };
    return builder;
  });

  return {
    admin: { from } as unknown as SupabaseClient<Database>,
    queries,
  };
}

describe("typed pipeline transitions", () => {
  it("keeps the generation claim CAS inside its owner", async () => {
    const { admin, queries } = createAdmin({ data: { id: "session-1" }, error: null });

    await expect(claimSessionForGeneration(admin, "session-1")).resolves.toMatchObject({
      claimed: true,
      error: null,
    });
    expect(queries).toEqual([
      {
        filters: [
          ["eq", "id", "session-1"],
          ["in", "phase_status", ["agent_generating", "awaiting_review", "rejected"]],
          ["is", "archived_at", null],
        ],
        patch: { phase_status: "agent_generating" },
        select: "id",
        table: "sessions",
      },
    ]);
  });

  it("claims rejection count with the complete expected state", async () => {
    const { admin, queries } = createAdmin({ data: { id: "session-1" }, error: null });

    await expect(
      claimSessionRejection(admin, {
        currentRejectionCount: 2,
        expectedVersion: 4,
        expectedWorkspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ claimed: true, nextRejectionCount: 3 });
    expect(queries[0]).toMatchObject({
      filters: [
        ["eq", "id", "session-1"],
        ["eq", "workspace_id", "workspace-1"],
        ["eq", "rejection_count", 2],
        ["eq", "phase_status", "awaiting_review"],
        ["eq", "current_artifact_version", 4],
        ["is", "archived_at", null],
      ],
      patch: { rejection_count: 3 },
    });
  });

  it("publishes rejection only against the rejection-owned state", async () => {
    const { admin, queries } = createAdmin({ data: { id: "session-1" }, error: null });

    await expect(
      publishRejectedSession(admin, {
        expectedRejectionCount: 3,
        expectedVersion: 4,
        expectedWorkspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ error: null, published: true });
    expect(queries[0]).toMatchObject({
      filters: [
        ["eq", "id", "session-1"],
        ["eq", "workspace_id", "workspace-1"],
        ["eq", "rejection_count", 3],
        ["eq", "phase_status", "awaiting_review"],
        ["eq", "current_artifact_version", 4],
        ["is", "archived_at", null],
      ],
      patch: { phase_status: "rejected" },
    });
  });

  it("keeps cancellation scoped to active session jobs", async () => {
    const { admin, queries } = createAdmin({ data: [{ id: "job-1" }], error: null });

    await cancelSessionAgentJobs(admin, {
      finishedAt: "2026-07-29T00:00:00.000Z",
      reason: "canceled",
      sessionId: "session-1",
    });
    expect(queries[0]).toMatchObject({
      filters: [
        ["eq", "session_id", "session-1"],
        ["in", "status", ["queued", "started", "running"]],
      ],
      patch: {
        finished_at: "2026-07-29T00:00:00.000Z",
        last_error: "canceled",
        status: "canceled",
      },
    });
  });
});
