import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((v: string) => `decrypted:${v}`),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { reconcileLinearState } from "./reconciler";
import { DEFAULT_LINEAR_STATUS_MAPPINGS } from "@/lib/linear-routing/contracts";

type SessionRow = {
  id: string;
  current_stage_id?: string;
  workspace_id: string;
  linear_issue_id: string | null;
  pipeline_id?: string;
  phase_status: string;
  created_at: string;
};

type SecretRow = { workspace_id: string; encrypted_value: string };
type AgentJobRow = { id: string; job_type?: string; session_id: string; status?: string };
type PipelineStageRow = { id: string; pipeline_id: string; position: number; slug: string };
type RoutingRow = {
  land_stage_slug: string;
  monitor_stage_slug: string | null;
  rework_stage_slug: string;
  status_mappings: unknown;
  workspace_id: string;
};

interface Fixture {
  sessions: SessionRow[];
  secrets: SecretRow[];
  agentJobs?: AgentJobRow[];
  pipelineStages?: PipelineStageRow[];
  routingRows?: RoutingRow[];
  /** Session ids whose `agent_jobs` cancel write should reject. */
  failCancelForSessionIds?: Set<string>;
}

/**
 * Build a chainable Supabase admin stub that responds to the exact queries
 * the reconciler issues — sessions paging, workspace_secrets lookup,
 * agent_jobs/agent_runs/sessions writes. Records mutations so tests can
 * assert side effects.
 */
function buildAdmin(fixture: Fixture) {
  const calls: {
    table: string;
    op: "delete" | "insert" | "select" | "update";
    update?: Record<string, unknown>;
    filters: Record<string, unknown>;
  }[] = [];

  function makeBuilder(
    table: string,
    op: "delete" | "insert" | "select" | "update",
    update?: Record<string, unknown>,
  ) {
    const filters: Record<string, unknown> = {};
    let cursorGt: string | null = null;
    let limit = Infinity;

    const builder: Record<string, unknown> = {
      not(col: string, _op: string, val: unknown) {
        filters[`not.${col}`] = val;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[`eq.${col}`] = val;
        return builder;
      },
      gt(col: string, val: string) {
        if (col === "created_at") cursorGt = val;
        filters[`gt.${col}`] = val;
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters[`in.${col}`] = vals;
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      maybeSingle() {
        return resolveQuery(true);
      },
      single() {
        return resolveQuery(true);
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolveQuery(false).then(onFulfilled, onRejected);
      },
    };

    function resolveQuery(single: boolean): Promise<{ data: unknown; error: null }> {
      calls.push({ table, op, update, filters });

      if (op === "select" && table === "sessions") {
        const eqPhaseStatus = filters["eq.phase_status"] as string | undefined;
        const inPhaseStatuses = filters["in.phase_status"] as string[] | undefined;
        let rows = fixture.sessions
          .filter((s) => s.linear_issue_id !== null)
          .filter((s) => !eqPhaseStatus || s.phase_status === eqPhaseStatus)
          .filter((s) => !inPhaseStatuses || inPhaseStatuses.includes(s.phase_status))
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (cursorGt) rows = rows.filter((s) => s.created_at > cursorGt!);
        rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null });
      }

      if (op === "select" && table === "workspace_secrets") {
        const wanted = (filters["in.workspace_id"] as string[] | undefined) ?? [];
        const rows = fixture.secrets.filter((s) => wanted.includes(s.workspace_id));
        return Promise.resolve({ data: rows, error: null });
      }

      if (op === "select" && table === "workspace_linear_routing") {
        const workspaceId = filters["eq.workspace_id"] as string | undefined;
        const rows = (fixture.routingRows ?? []).filter(
          (row) => !workspaceId || row.workspace_id === workspaceId,
        );
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
      }

      if (op === "select" && table === "pipeline_stages") {
        const pipelineId = filters["eq.pipeline_id"] as string | undefined;
        const rows = (fixture.pipelineStages ?? [])
          .filter((stage) => !pipelineId || stage.pipeline_id === pipelineId)
          .sort((a, b) => a.position - b.position);
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
      }

      if (op === "select" && table === "agent_jobs") {
        const sessionId = filters["eq.session_id"] as string | undefined;
        const jobType = filters["eq.job_type"] as string | undefined;
        const statuses = filters["in.status"] as string[] | undefined;
        let rows = (fixture.agentJobs ?? [])
          .filter((j) => !sessionId || j.session_id === sessionId)
          .filter((j) => !jobType || (j.job_type ?? "session") === jobType)
          .filter((j) => !statuses || statuses.includes(j.status ?? "queued"));
        rows = rows.slice(0, limit);
        const data = single ? (rows[0] ?? null) : rows.map((j) => ({ id: j.id }));
        return Promise.resolve({ data, error: null });
      }

      if (
        op === "update" &&
        table === "agent_jobs" &&
        fixture.failCancelForSessionIds &&
        fixture.failCancelForSessionIds.has(filters["eq.session_id"] as string)
      ) {
        return Promise.reject(new Error("simulated supabase write failure"));
      }

      if (op === "insert" && table === "agent_jobs") {
        return Promise.resolve({
          data: { id: "inserted-job", ...(update ?? {}) },
          error: null,
        });
      }

      // For update / unhandled selects — return empty success.
      return Promise.resolve({ data: single ? null : [], error: null });
    }

    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeBuilder(table, "select");
        },
        update(values: Record<string, unknown>) {
          return makeBuilder(table, "update", values);
        },
        insert(values: Record<string, unknown>) {
          return makeBuilder(table, "insert", values);
        },
        delete() {
          return makeBuilder(table, "delete");
        },
      };
    },
  };

  return { admin, calls };
}

function makeFetchResponse(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { "Content-Type": "application/json" },
  });
}

function routingRow(overrides: Partial<RoutingRow> = {}): RoutingRow {
  return {
    land_stage_slug: "land",
    monitor_stage_slug: null,
    rework_stage_slug: "engineering",
    status_mappings: DEFAULT_LINEAR_STATUS_MAPPINGS,
    workspace_id: "wA",
    ...overrides,
  };
}

describe("reconcileLinearState", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues one batched GraphQL request per workspace per page", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "s1",
          workspace_id: "wA",
          linear_issue_id: "i1",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "s2",
          workspace_id: "wA",
          linear_issue_id: "i2",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:01Z",
        },
        {
          id: "s3",
          workspace_id: "wA",
          linear_issue_id: "i3",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:02Z",
        },
        {
          id: "s4",
          workspace_id: "wB",
          linear_issue_id: "i4",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:03Z",
        },
      ],
      secrets: [
        { workspace_id: "wA", encrypted_value: "keyA" },
        { workspace_id: "wB", encrypted_value: "keyB" },
      ],
    };
    const { admin } = buildAdmin(fixture);

    fetchSpy.mockImplementation(async () => makeFetchResponse({ data: { issues: { nodes: [] } } }));

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const batchedRequests = fetchSpy.mock.calls.map(([, init]) => {
      const requestInit = init as RequestInit;
      return {
        auth: (requestInit.headers as Record<string, string>).Authorization,
        ids: JSON.parse(requestInit.body as string).variables.ids,
      };
    });
    expect(batchedRequests).toEqual([
      { auth: "decrypted:keyA", ids: ["i1", "i2", "i3"] },
      { auth: "decrypted:keyB", ids: ["i4"] },
    ]);

    expect(result.checked).toBe(4);
    expect(result.canceled).toBe(0);
    expect(result.rateLimited).toBe(false);
  });

  it("cancels sessions whose Linear issue is in a terminal state", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "s1",
          workspace_id: "wA",
          linear_issue_id: "iActive",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "s2",
          workspace_id: "wA",
          linear_issue_id: "iDone",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:01Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: {
          issues: {
            nodes: [
              { id: "iActive", state: { type: "started" } },
              { id: "iDone", state: { type: "canceled" } },
            ],
          },
        },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(2);
    expect(result.canceled).toBe(1);

    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          "eq.id": "s2",
          "in.phase_status": ["agent_generating", "awaiting_review", "rejected"],
        }),
        op: "update",
        table: "sessions",
        update: expect.objectContaining({
          archived_at: expect.any(String),
          phase_status: "rejected",
        }),
      }),
    );

    expect(
      calls.find(
        (c) =>
          c.table === "sessions" &&
          c.op === "update" &&
          c.update?.phase_status === "rejected" &&
          c.filters["eq.id"] === "s1",
      ),
    ).toBeUndefined();
  });

  it("cancels active non-terminal sessions, including awaiting_review, for canceled issues", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "sGenerating",
          workspace_id: "wA",
          linear_issue_id: "iGenerating",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "sReview",
          workspace_id: "wA",
          linear_issue_id: "iReview",
          phase_status: "awaiting_review",
          created_at: "2026-05-01T00:00:01Z",
        },
        {
          id: "sRejected",
          workspace_id: "wA",
          linear_issue_id: "iRejected",
          phase_status: "rejected",
          created_at: "2026-05-01T00:00:02Z",
        },
        {
          id: "sApproved",
          workspace_id: "wA",
          linear_issue_id: "iApproved",
          phase_status: "approved",
          created_at: "2026-05-01T00:00:03Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      agentJobs: [
        { id: "jobReview", session_id: "sReview" },
        { id: "jobRejected", session_id: "sRejected" },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: {
          issues: {
            nodes: [
              { id: "iGenerating", state: { type: "canceled" } },
              { id: "iReview", state: { type: "canceled" } },
              { id: "iRejected", state: { type: "canceled" } },
            ],
          },
        },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(3);
    expect(result.canceled).toBe(3);

    const sessionsScan = calls.find((c) => c.table === "sessions" && c.op === "select");
    expect(sessionsScan?.filters["in.phase_status"]).toEqual([
      "agent_generating",
      "awaiting_review",
      "rejected",
    ]);

    const fetchBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(fetchBody.variables.ids).toEqual(["iGenerating", "iReview", "iRejected"]);

    for (const sessionId of ["sGenerating", "sReview", "sRejected"]) {
      const sessionRejection = calls.find(
        (c) =>
          c.table === "sessions" &&
          c.op === "update" &&
          c.update?.phase_status === "rejected" &&
          c.filters["eq.id"] === sessionId,
      );
      expect(sessionRejection).toBeDefined();
      expect(sessionRejection?.filters["in.phase_status"]).toEqual([
        "agent_generating",
        "awaiting_review",
        "rejected",
      ]);
    }

    for (const sessionId of ["sGenerating", "sReview", "sRejected"]) {
      const jobCancel = calls.find(
        (c) =>
          c.table === "agent_jobs" &&
          c.op === "update" &&
          c.update?.status === "canceled" &&
          c.filters["eq.session_id"] === sessionId,
      );
      expect(jobCancel).toBeDefined();
      expect(jobCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);
    }

    const runCancel = calls.find(
      (c) => c.table === "agent_runs" && c.op === "update" && c.update?.status === "canceled",
    );
    expect(runCancel?.filters["in.agent_job_id"]).toEqual(["jobReview"]);
    expect(runCancel?.filters["in.status"]).toEqual(["queued", "started", "running"]);

    for (const sessionId of ["sApproved"]) {
      const sessionRejection = calls.find(
        (c) =>
          c.table === "sessions" &&
          c.op === "update" &&
          c.update?.phase_status === "rejected" &&
          c.filters["eq.id"] === sessionId,
      );
      expect(sessionRejection).toBeUndefined();
    }
  });

  it("uses workspace routing config to classify custom terminal status names", async () => {
    const fixture: Fixture = {
      routingRows: [
        routingRow({
          status_mappings: {
            ...DEFAULT_LINEAR_STATUS_MAPPINGS,
            done: ["Ready to Archive"],
          },
        }),
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sCustomDone",
          workspace_id: "wA",
          linear_issue_id: "iCustomDone",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: {
          issues: {
            nodes: [{ id: "iCustomDone", state: { name: "Ready to Archive", type: "started" } }],
          },
        },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(result.canceled).toBe(1);
    expect(
      calls.find(
        (c) =>
          c.table === "sessions" &&
          c.op === "update" &&
          c.filters["eq.id"] === "sCustomDone" &&
          c.update?.phase_status === "rejected" &&
          typeof c.update.archived_at === "string",
      ),
    ).toBeDefined();
  });

  it("routes Rework to the configured stage, clears later artifacts, and queues a job", async () => {
    const fixture: Fixture = {
      pipelineStages: [
        { id: "stage-product", pipeline_id: "pipe-1", position: 1, slug: "product" },
        { id: "stage-engineering", pipeline_id: "pipe-1", position: 2, slug: "engineering" },
        { id: "stage-review", pipeline_id: "pipe-1", position: 3, slug: "review" },
        { id: "stage-land", pipeline_id: "pipe-1", position: 4, slug: "land" },
      ],
      routingRows: [routingRow({ rework_stage_slug: "engineering" })],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sRework",
          current_stage_id: "stage-review",
          pipeline_id: "pipe-1",
          workspace_id: "wA",
          linear_issue_id: "iRework",
          phase_status: "awaiting_review",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iRework", state: { name: "Rework" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(result.canceled).toBe(0);

    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          "eq.session_id": "sRework",
          "in.stage_id": ["stage-engineering", "stage-review", "stage-land"],
        }),
        op: "delete",
        table: "session_artifact_feedback",
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          "eq.session_id": "sRework",
          "in.stage_slug": ["engineering", "review", "land"],
        }),
        op: "delete",
        table: "session_artifacts",
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          "eq.id": "sRework",
          "in.phase_status": ["agent_generating", "awaiting_review", "rejected"],
        }),
        op: "update",
        table: "sessions",
        update: {
          archived_at: null,
          current_artifact_version: 0,
          current_stage_id: "stage-engineering",
          phase_status: "rejected",
          rejection_count: 0,
        },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "agent_jobs",
        update: expect.objectContaining({
          dedupe_key: "pipeline:iRework:active",
          job_type: "session",
          session_id: "sRework",
          trigger_type: "assignment",
          workspace_id: "wA",
        }),
      }),
    );
  });

  it("routes Merging to the configured land stage", async () => {
    const fixture: Fixture = {
      pipelineStages: [
        { id: "stage-engineering", pipeline_id: "pipe-1", position: 1, slug: "engineering" },
        { id: "stage-land", pipeline_id: "pipe-1", position: 2, slug: "land" },
      ],
      routingRows: [routingRow({ land_stage_slug: "land" })],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sMerge",
          current_stage_id: "stage-engineering",
          pipeline_id: "pipe-1",
          workspace_id: "wA",
          linear_issue_id: "iMerge",
          phase_status: "awaiting_review",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iMerge", state: { name: "Merging" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ "eq.id": "sMerge" }),
        op: "update",
        table: "sessions",
        update: expect.objectContaining({
          current_stage_id: "stage-land",
          phase_status: "rejected",
        }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "agent_jobs",
        update: expect.objectContaining({
          dedupe_key: "pipeline:iMerge:active",
          session_id: "sMerge",
          trigger_type: "assignment",
        }),
      }),
    );
  });

  it("queues rework when the session is awaiting review on the target stage", async () => {
    const fixture: Fixture = {
      pipelineStages: [
        { id: "stage-engineering", pipeline_id: "pipe-1", position: 1, slug: "engineering" },
        { id: "stage-review", pipeline_id: "pipe-1", position: 2, slug: "review" },
      ],
      routingRows: [routingRow({ rework_stage_slug: "engineering" })],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sReworkCurrent",
          current_stage_id: "stage-engineering",
          pipeline_id: "pipe-1",
          workspace_id: "wA",
          linear_issue_id: "iReworkCurrent",
          phase_status: "awaiting_review",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iReworkCurrent", state: { name: "Rework" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(calls).toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "agent_jobs",
        update: expect.objectContaining({
          dedupe_key: "pipeline:iReworkCurrent:active",
          session_id: "sReworkCurrent",
          trigger_type: "assignment",
        }),
      }),
    );
  });

  it("requeues awaiting_review sessions when Linear moves back to Todo", async () => {
    const fixture: Fixture = {
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sReview",
          current_stage_id: "stage-engineering",
          pipeline_id: "pipe-1",
          workspace_id: "wA",
          linear_issue_id: "iTodo",
          phase_status: "awaiting_review",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iTodo", state: { name: "Todo" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(calls).toContainEqual(
      expect.objectContaining({
        op: "insert",
        table: "agent_jobs",
        update: expect.objectContaining({
          dedupe_key: "pipeline:iTodo:active",
          session_id: "sReview",
          trigger_type: "assignment",
        }),
      }),
    );
  });

  it("treats started pipeline jobs as active before queueing new work", async () => {
    const fixture: Fixture = {
      agentJobs: [
        { id: "jobStarted", job_type: "session", session_id: "sStarted", status: "started" },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      sessions: [
        {
          id: "sStarted",
          current_stage_id: "stage-engineering",
          pipeline_id: "pipe-1",
          workspace_id: "wA",
          linear_issue_id: "iTodo",
          phase_status: "rejected",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iTodo", state: { name: "Todo" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(1);
    expect(calls.find((c) => c.table === "agent_jobs" && c.op === "insert")).toBeUndefined();
  });

  it("does not touch approved sessions even if their Linear issue would be terminal", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "sApproved",
          workspace_id: "wA",
          linear_issue_id: "iCanceled",
          phase_status: "approved",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: { issues: { nodes: [{ id: "iCanceled", state: { type: "canceled" } }] } },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(0);
    expect(result.canceled).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      calls.find(
        (c) => c.table === "sessions" && c.op === "update" && c.update?.phase_status === "rejected",
      ),
    ).toBeUndefined();
  });

  it("retries once after a 429 with Retry-After", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "s1",
          workspace_id: "wA",
          linear_issue_id: "i1",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
    };
    const { admin } = buildAdmin(fixture);
    const sleep = vi.fn(() => Promise.resolve());

    fetchSpy
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          data: { issues: { nodes: [{ id: "i1", state: { type: "started" } }] } },
        }),
      );

    const result = await reconcileLinearState(admin as never, { sleep });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result.rateLimited).toBe(false);
    expect(result.checked).toBe(1);
  });

  it("aborts the sweep if rate-limited a second time", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "s1",
          workspace_id: "wA",
          linear_issue_id: "i1",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "s2",
          workspace_id: "wB",
          linear_issue_id: "i2",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:01Z",
        },
      ],
      secrets: [
        { workspace_id: "wA", encrypted_value: "keyA" },
        { workspace_id: "wB", encrypted_value: "keyB" },
      ],
    };
    const { admin } = buildAdmin(fixture);
    const sleep = vi.fn(() => Promise.resolve());

    fetchSpy.mockImplementation(async () => new Response("rate limited", { status: 429 }));

    const result = await reconcileLinearState(admin as never, { sleep });

    expect(result.rateLimited).toBe(true);
    expect(result.checked).toBe(0);
    // First workspace: initial 429 + retry 429 = 2 fetches, then abort.
    // The second workspace must NOT be fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("continues the sweep when a single session's cancel write fails", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "sFail",
          workspace_id: "wA",
          linear_issue_id: "iDoneFail",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "sOk",
          workspace_id: "wA",
          linear_issue_id: "iDoneOk",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:01Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
      failCancelForSessionIds: new Set(["sFail"]),
    };
    const { admin, calls } = buildAdmin(fixture);

    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: {
          issues: {
            nodes: [
              { id: "iDoneFail", state: { type: "canceled" } },
              { id: "iDoneOk", state: { type: "canceled" } },
            ],
          },
        },
      }),
    );

    const result = await reconcileLinearState(admin as never, { sleep: vi.fn() });

    expect(result.checked).toBe(2);
    // Only the second session gets fully canceled — the first throws mid-cancel.
    expect(result.canceled).toBe(1);

    expect(calls).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          "eq.id": "sOk",
          "in.phase_status": ["agent_generating", "awaiting_review", "rejected"],
        }),
        op: "update",
        table: "sessions",
        update: expect.objectContaining({
          archived_at: expect.any(String),
          phase_status: "rejected",
        }),
      }),
    );
  });

  it("treats GraphQL RATELIMITED envelope the same as a 429", async () => {
    const fixture: Fixture = {
      sessions: [
        {
          id: "s1",
          workspace_id: "wA",
          linear_issue_id: "i1",
          phase_status: "agent_generating",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      secrets: [{ workspace_id: "wA", encrypted_value: "keyA" }],
    };
    const { admin } = buildAdmin(fixture);
    const sleep = vi.fn(() => Promise.resolve());

    fetchSpy
      .mockResolvedValueOnce(
        makeFetchResponse({
          errors: [{ message: "rate limited", extensions: { code: "RATELIMITED" } }],
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          data: { issues: { nodes: [{ id: "i1", state: { type: "done" } }] } },
        }),
      );

    const result = await reconcileLinearState(admin as never, { sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.rateLimited).toBe(false);
    expect(result.canceled).toBe(1);
  });
});
