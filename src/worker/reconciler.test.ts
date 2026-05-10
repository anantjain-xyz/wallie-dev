import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((v: string) => `decrypted:${v}`),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { reconcileLinearState } from "./reconciler";

type SessionRow = {
  id: string;
  workspace_id: string;
  linear_issue_id: string | null;
  phase_status: string;
  created_at: string;
};

type SecretRow = { workspace_id: string; encrypted_value: string };

interface Fixture {
  sessions: SessionRow[];
  secrets: SecretRow[];
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
    op: "select" | "update";
    update?: Record<string, unknown>;
    filters: Record<string, unknown>;
  }[] = [];

  function makeBuilder(table: string, op: "select" | "update", update?: Record<string, unknown>) {
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
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolveQuery(false).then(onFulfilled, onRejected);
      },
    };

    function resolveQuery(single: boolean): Promise<{ data: unknown; error: null }> {
      calls.push({ table, op, update, filters });

      if (op === "select" && table === "sessions") {
        let rows = fixture.sessions
          .filter((s) => s.phase_status === "agent_generating")
          .filter((s) => s.linear_issue_id !== null)
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

      if (op === "select" && table === "agent_jobs") {
        // The reconciler only selects job ids when canceling — return empty.
        const data = single ? null : [];
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
          "eq.phase_status": "agent_generating",
        }),
        op: "update",
        table: "sessions",
        update: { phase_status: "rejected" },
      }),
    );

    expect(calls).not.toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ "eq.id": "s1" }),
        op: "update",
        table: "sessions",
        update: { phase_status: "rejected" },
      }),
    );
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
          "eq.phase_status": "agent_generating",
        }),
        op: "update",
        table: "sessions",
        update: { phase_status: "rejected" },
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
