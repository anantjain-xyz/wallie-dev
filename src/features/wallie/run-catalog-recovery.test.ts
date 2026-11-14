import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";

const { createAdmin } = vi.hoisted(() => ({ createAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: createAdmin }));

import { loadRunCatalogRecovery } from "./run-catalog-recovery";

type Row = Parameters<typeof loadRunCatalogRecovery>[0]["rows"][number];
const workspaceId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const now = "2026-11-14T20:00:00.000Z";
const old = "2026-11-14T19:30:00.000Z";
const future = "2026-11-14T20:10:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n = 10, changes: Partial<Row> = {}): Row => ({
  run_id: uuid(n),
  session_id: sessionId,
  job_id: uuid(n + 100),
  attempt_count: 1,
  status: "running",
  source_recovery_required: false,
  created_at: old,
  last_activity_at: now,
  ...changes,
});
const job = (run: Row, changes: Record<string, unknown> = {}) => ({
  id: run.job_id,
  workspace_id: workspaceId,
  session_id: run.session_id,
  attempt_count: run.attempt_count,
  status: "running",
  scheduled_at: null,
  ...changes,
});
const publication = (run: Row, changes: Record<string, unknown> = {}) => ({
  run_id: run.run_id,
  workspace_id: workspaceId,
  session_id: run.session_id,
  job_id: run.job_id,
  attempt_count: run.attempt_count,
  status: "pending",
  deadline_at: future,
  next_attempt_at: now,
  publication_attempt_count: 2,
  lease_expires_at: null,
  ...changes,
});
const dispatch = (run: Row, changes: Record<string, unknown> = {}) => ({
  workspace_id: workspaceId,
  job_id: run.job_id,
  attempt_count: run.attempt_count,
  deadline_at: future,
  dispatched_at: now,
  execution_started_at: now,
  ...changes,
});

function fixture(data: Record<string, unknown[]> = {}, failedTable?: string) {
  const requests: URL[] = [];
  const supabase = createClient<Database>("https://database.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        requests.push(url);
        const table = url.pathname.split("/").at(-1) ?? "";
        return new Response(
          JSON.stringify(
            table === failedTable ? { message: "private backend error" } : (data[table] ?? []),
          ),
          {
            status: table === failedTable ? 500 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });
  createAdmin.mockReturnValue(supabase);
  return { supabase, requests };
}

beforeEach(() => {
  createAdmin.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
});

afterEach(() => vi.restoreAllMocks());

describe("loadRunCatalogRecovery", () => {
  it("does no privileged or config reads for empty pages and rejects oversized pages", async () => {
    const { supabase, requests } = fixture();
    expect(await loadRunCatalogRecovery({ supabase, workspaceId, rows: [] })).toEqual(new Map());
    await expect(
      loadRunCatalogRecovery({
        supabase,
        workspaceId,
        rows: Array.from({ length: 52 }, (_, n) => row(n)),
      }),
    ).rejects.toThrow("page limit");
    expect(createAdmin).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("returns bounded exact-attempt recovery facts without source payloads or worker identity", async () => {
    const run = row(10, { source_recovery_required: true, last_activity_at: old });
    const { supabase, requests } = fixture({
      agent_jobs: [job(run)],
      session_checkpoint_publications: [publication(run)],
      session_retry_checkpoints: [
        { source_run_id: run.run_id, source_attempt_count: 1, workspace_id: workspaceId },
      ],
      worker_dispatches: [dispatch(run)],
      workspace_agent_config: [{ value_json: 60_000 }],
    });
    const result = (await loadRunCatalogRecovery({ supabase, workspaceId, rows: [run] })).get(
      run.run_id,
    );
    expect(result).toMatchObject({
      metadataAvailable: true,
      queue: { state: "current", status: "running", attemptCount: 1 },
      publication: {
        status: "pending",
        deadlineAt: future,
        deadlineExpired: false,
        attemptCount: 2,
      },
      sourceRecoveryRequired: true,
      retryCheckpointAvailable: true,
      activity: { state: "stale", observedAt: old, thresholdMs: 60_000 },
      worker: { state: "execution_started", executionStartedAt: now },
    });
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(request.searchParams.get("select")).not.toMatch(
        /artifact_md|last_error|claim_id|checkpoint_path|workflow_id/,
      );
      if (!request.pathname.endsWith("workspace_agent_config"))
        expect(request.searchParams.get("limit")).toBe("1");
    }
    expect(
      requests
        .find((request) => request.pathname.endsWith("worker_dispatches"))
        ?.searchParams.get("or"),
    ).toBe(`(and(job_id.eq.${run.job_id},attempt_count.eq.1))`);
  });

  it("separates an unclaimed placeholder, scheduled retry, and superseded historical attempt", async () => {
    const waiting = row(10, { status: "queued", attempt_count: null });
    const retry = row(11, { status: "error" });
    const history = row(12, { status: "error" });
    const { supabase } = fixture({
      agent_jobs: [
        job(waiting, { status: "queued", attempt_count: 0 }),
        job(retry, { status: "queued", scheduled_at: future }),
        job(history, { attempt_count: 2 }),
      ],
      worker_dispatches: [
        dispatch(history, { attempt_count: 2 }),
        dispatch(retry, { deadline_at: old }),
      ],
    });
    const result = await loadRunCatalogRecovery({
      supabase,
      workspaceId,
      rows: [waiting, retry, history],
    });
    expect(result.get(waiting.run_id)).toMatchObject({
      queue: { state: "unclaimed", attemptCount: 0 },
      activity: { state: "unknown" },
    });
    expect(result.get(retry.run_id)?.queue).toMatchObject({
      state: "retry_scheduled",
      scheduledAt: future,
    });
    expect(result.get(retry.run_id)?.worker.state).toBe("unobserved");
    expect(result.get(history.run_id)).toMatchObject({
      queue: { state: "superseded", attemptCount: 2 },
      worker: { state: "unobserved" },
    });
    expect(history.status).toBe("error");
  });

  it.each([
    { attempt_count: 2 },
    { job_id: uuid(999) },
    { session_id: uuid(999) },
    { workspace_id: uuid(999) },
    { status: "future-status" },
  ])(
    "ignores publication metadata with a mismatched identity or unknown status: %j",
    async (changes) => {
      const run = row();
      const { supabase } = fixture({
        agent_jobs: [job(run)],
        session_checkpoint_publications: [publication(run, changes)],
      });
      expect(
        (await loadRunCatalogRecovery({ supabase, workspaceId, rows: [run] })).get(run.run_id)
          ?.publication,
      ).toBeNull();
    },
  );

  it("does not infer ownership for legacy runs or attach other sessions and attempts", async () => {
    const legacy = row(10, { attempt_count: null });
    const foreign = row(11);
    const run = row(12);
    const { supabase } = fixture({
      agent_jobs: [
        job(legacy, { attempt_count: 1 }),
        job(foreign, { session_id: uuid(999) }),
        job(run),
      ],
      session_checkpoint_publications: [publication(legacy, { attempt_count: 1 })],
      session_retry_checkpoints: [
        { source_run_id: run.run_id, source_attempt_count: 2, workspace_id: workspaceId },
      ],
      worker_dispatches: [dispatch(run, { attempt_count: 2 })],
    });
    const result = await loadRunCatalogRecovery({
      supabase,
      workspaceId,
      rows: [legacy, foreign, run],
    });
    expect(result.get(legacy.run_id)).toMatchObject({
      queue: { state: "unknown" },
      publication: null,
    });
    expect(result.get(foreign.run_id)?.queue.state).toBe("unknown");
    expect(result.get(run.run_id)).toMatchObject({
      retryCheckpointAvailable: false,
      worker: { state: "unobserved" },
    });
  });

  it.each([
    "agent_jobs",
    "session_checkpoint_publications",
    "session_retry_checkpoints",
    "workspace_agent_config",
    "worker_dispatches",
  ])("labels unavailable %s metadata without exposing errors", async (failedTable) => {
    const run = row(10, { source_recovery_required: true });
    const { supabase } = fixture({ agent_jobs: [job(run)] }, failedTable);
    const result = (await loadRunCatalogRecovery({ supabase, workspaceId, rows: [run] })).get(
      run.run_id,
    );
    expect(result).toMatchObject({ metadataAvailable: false, sourceRecoveryRequired: true });
    expect(JSON.stringify(result)).not.toContain("private backend error");
    if (failedTable === "session_retry_checkpoints")
      expect(result?.retryCheckpointAvailable).toBeNull();
    if (failedTable === "workspace_agent_config") expect(result?.activity.state).toBe("unknown");
    if (failedTable === "agent_jobs" || failedTable === "worker_dispatches")
      expect(result?.worker.state).toBe("unknown");
  });

  it.each([
    { last_activity_at: now, status: "running", state: "recent" },
    { last_activity_at: null, status: "started", state: "stale" },
    { last_activity_at: "invalid", status: "running", state: "unknown" },
    { last_activity_at: future, status: "running", state: "unknown" },
    { last_activity_at: old, status: "success", state: "unknown" },
  ] satisfies Array<{ last_activity_at: string | null; status: Row["status"]; state: string }>)(
    "reports activity age without claiming stalled execution: %j",
    async ({ state, ...changes }) => {
      const run = row(10, changes);
      const { supabase } = fixture({
        agent_jobs: [job(run)],
        workspace_agent_config: [{ value_json: -1 }],
      });
      expect(
        (await loadRunCatalogRecovery({ supabase, workspaceId, rows: [run] })).get(run.run_id)
          ?.activity.state,
      ).toBe(state);
    },
  );
});
