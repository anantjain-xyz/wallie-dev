import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/worker/wake", () => ({ wakeWorker: mocks.wake }));

import { GET, POST } from "./route";

const id = (part: number) => `61800000-0000-4000-8000-${String(part).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const experimentId = id(4);
const context = { params: Promise.resolve({ workspaceId, factoryId, experimentId }) };
const scheduleUrl = `https://factory.test/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/experiments/${experimentId}/schedule`;
const scopedRpcArgs = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_experiment_id: experimentId,
  p_actor_user_id: actorUserId,
};
const configure = {
  action: "configure",
  runnerRevision: "recorded-fixture-v1",
  sandboxConnectionRevision: id(5),
  taskFixtures: [{ taskRevisionId: id(6), fixtureKey: "a".repeat(64) }],
  executionReserveUsd: 0.1,
  evaluationReserveUsd: 0.05,
  budgetLimitUsd: 1,
  factoryConcurrencyLimit: 2,
  maxAdmittedTrials: 5,
};
const snapshot = {
  experimentId,
  state: "active",
  runnerRevision: configure.runnerRevision,
  sandboxConnectionRevision: configure.sandboxConnectionRevision,
  budgetLimitUsd: configure.budgetLimitUsd,
  executionReserveUsd: configure.executionReserveUsd,
  evaluationReserveUsd: configure.evaluationReserveUsd,
  factoryConcurrencyLimit: configure.factoryConcurrencyLimit,
  maxAdmittedTrials: configure.maxAdmittedTrials,
  plannedTrialCount: 8,
  eligibleTrialCount: 4,
  admittedTrialCount: 2,
  queuedTrialCount: 0,
  runningTrialCount: 1,
  terminalTrialCount: 1,
  executionSpentUsd: 0,
  evaluationSpentUsd: 0,
  reservedUsd: 0.2,
  unavailableExecutionCount: 1,
  unavailableEvaluationCount: 0,
  admissionIssue: null,
};

function setup(fetchRpc: typeof fetch, visible = true) {
  const supabase = createClient<Database>("https://factory.test", "reader", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/factories");
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json(visible ? { id: factoryId } : null);
      },
    },
  });
  const admin = createClient<Database>("https://factory.test", "writer", {
    auth: { persistSession: false },
    global: { fetch: fetchRpc },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: actorUserId }, supabase } });
  mocks.admin.mockReturnValue(admin);
}

function post(body: unknown, headers: HeadersInit = { "content-type": "application/json" }) {
  return new Request(scheduleUrl, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("benchmark schedule route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("configures an exact fixture runner using the path scope and authenticated manager", async () => {
    const rpc = vi.fn<typeof fetch>(async () => Response.json(snapshot));
    setup(rpc);

    const response = await POST(post(configure), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "https://factory.test/rest/v1/rpc/configure_factory_benchmark_schedule",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          ...scopedRpcArgs,
          p_runner_revision: configure.runnerRevision,
          p_sandbox_connection_revision: configure.sandboxConnectionRevision,
          p_task_fixtures: configure.taskFixtures,
          p_execution_reserve_usd: configure.executionReserveUsd,
          p_evaluation_reserve_usd: configure.evaluationReserveUsd,
          p_budget_limit_usd: configure.budgetLimitUsd,
          p_factory_concurrency_limit: configure.factoryConcurrencyLimit,
          p_max_admitted_trials: configure.maxAdmittedTrials,
        }),
      }),
    );
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it.each([
    ["pause", "paused"],
    ["resume", "active"],
    ["cancel", "canceled"],
  ])("forwards %s and returns the durable %s state", async (action, state) => {
    const rpc = vi.fn<typeof fetch>(async () => Response.json({ ...snapshot, state }));
    setup(rpc);

    const response = await POST(post({ action }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "https://factory.test/rest/v1/rpc/control_factory_benchmark_schedule",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...scopedRpcArgs, p_action: action }),
      }),
    );
  });

  it("reads reserved spend and unavailable usage without waking a worker", async () => {
    const rpc = vi.fn<typeof fetch>(async () => Response.json(snapshot));
    setup(rpc);

    const response = await GET(new Request(scheduleUrl), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "https://factory.test/rest/v1/rpc/read_factory_benchmark_schedule",
      expect.objectContaining({ body: JSON.stringify(scopedRpcArgs) }),
    );
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it.each([
    { ...configure, runnerRevision: "opencode" },
    { ...configure, actorUserId: id(7) },
    { ...configure, experimentId: id(7) },
    { ...configure, taskFixtures: [...configure.taskFixtures, ...configure.taskFixtures] },
    { ...configure, executionReserveUsd: 0.1000001 },
    { ...configure, executionReserveUsd: 2 },
  ])(
    "rejects invalid or caller-supplied identity fields before creating an admin client",
    async (body) => {
      const rpc = vi.fn<typeof fetch>();
      setup(rpc);

      const response = await POST(post(body), context);

      expect(response.status).toBe(400);
      expect(mocks.admin).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("enforces media type, request bounds and factory visibility", async () => {
    const rpc = vi.fn<typeof fetch>();
    setup(rpc);
    await expect(
      POST(post(configure, { "content-type": "text/plain" }), context),
    ).resolves.toHaveProperty("status", 415);
    await expect(
      POST(
        post(configure, { "content-type": "application/json", "content-length": "2097153" }),
        context,
      ),
    ).resolves.toHaveProperty("status", 413);
    setup(rpc, false);
    await expect(POST(post(configure), context)).resolves.toHaveProperty("status", 404);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("withholds database diagnostics and refuses a different experiment projection", async () => {
    const rpc = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: "42501", message: "private database diagnostic" }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json({ ...snapshot, experimentId: id(7) }));
    setup(rpc);

    const forbidden = await POST(post({ action: "resume" }), context);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      error: "Factory manager access is required.",
    });
    const inconsistent = await GET(new Request(scheduleUrl), context);
    expect(inconsistent.status).toBe(500);
    await expect(inconsistent.json()).resolves.toEqual({
      error: "The benchmark schedule request failed.",
    });
    expect(mocks.wake).not.toHaveBeenCalled();
  });
});
