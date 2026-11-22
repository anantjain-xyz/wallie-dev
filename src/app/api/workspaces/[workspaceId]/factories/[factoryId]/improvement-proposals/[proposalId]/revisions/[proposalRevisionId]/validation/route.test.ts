import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FactoryImprovementValidationCommand,
  FactoryImprovementValidationReceipt,
} from "@/lib/factory-proposals/validation-contracts";
import { checkRateLimit, clearRateLimitsForTesting, RATE_LIMITS } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database.types";

import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/worker/wake", () => ({ wakeWorker: mocks.wake }));

const id = (slot: number) => `63800000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const proposalId = id(4);
const proposalRevisionId = id(5);
const context = {
  params: Promise.resolve({ workspaceId, factoryId, proposalId, proposalRevisionId }),
};
const origin = "https://wallie.test";
const url = `${origin}/api/workspaces/${workspaceId}/factories/${factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/validation`;
const base = { activationNumber: 3, revisionId: id(6), digest: "a".repeat(64) };
const candidate = { revisionId: id(7), digest: "b".repeat(64) };
const command = {
  requestId: id(8),
  targetedSuiteRevisionId: id(9),
  holdoutSuiteRevisionId: id(10),
  policyRevisionId: id(11),
  scorerRevisionId: id(12),
  candidates: [
    { definitionRevisionId: base.revisionId, qualificationId: id(13), workerRuntime: "workerd" },
    {
      definitionRevisionId: candidate.revisionId,
      qualificationId: id(14),
      workerRuntime: "workerd",
    },
  ],
  execution: {
    repetitions: 3,
    seed: 74,
    timeoutMs: 120_000,
    inferenceConnectionRevision: id(15),
    executionReserveUsd: 0.1,
    evaluationReserveUsd: 0.01,
    evaluationBudgetLimitUsd: 1,
    targetedBudgetLimitUsd: 2,
    holdoutBudgetLimitUsd: 3,
    factoryConcurrencyLimit: 2,
    maxAdmittedTrials: 25,
  },
  thresholds: {
    minimumIndependentTasks: 2,
    minimumCoverageBps: 9000,
    minimumCandidatePassRateBps: 7500,
    maxPassRateDropBps: 0,
    maxMeanCostIncreaseBps: 1000,
    maxP95LatencyIncreaseBps: 1500,
  },
} satisfies FactoryImprovementValidationCommand;
const arm = {
  candidateKey: "c".repeat(64),
  plannedTrials: 6,
  resolvedTrials: 0,
  passes: 0,
  measuredCostTrials: 0,
  measuredLatencyTrials: 0,
  passRateBps: null,
  meanCostUsd: null,
  p95LatencyMs: null,
};
const initial = {
  suiteRevisionId: command.targetedSuiteRevisionId,
  experimentId: id(18),
  scheduleState: "active",
  status: "inconclusive",
  reasons: ["pending_work", "unknown_quality", "unknown_cost", "unknown_latency"],
  independentTasks: 0,
  plannedPairs: 6,
  resolvedPairs: 0,
  coverageBps: 0,
  regressions: 0,
  baseline: arm,
  candidate: { ...arm, candidateKey: "d".repeat(64) },
} satisfies FactoryImprovementValidationReceipt["targeted"];
const receipt = {
  id: id(16),
  authorMemberId: id(17),
  createdAt: "2026-11-22T05:00:00+00:00",
  asOf: "2026-11-22T05:01:00+00:00",
  proposalId,
  proposalRevisionId,
  requestId: command.requestId,
  policyRevisionId: command.policyRevisionId,
  scorerRevisionId: command.scorerRevisionId,
  axes: command.candidates,
  execution: command.execution,
  thresholds: command.thresholds,
  base,
  candidate,
  status: "inconclusive",
  reasons: ["targeted_inconclusive", "holdout_inconclusive"],
  targeted: initial,
  holdout: { ...initial, experimentId: id(19), suiteRevisionId: command.holdoutSuiteRevisionId },
} satisfies FactoryImprovementValidationReceipt;

const scopedArgs = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_actor_user_id: actorUserId,
  p_proposal_id: proposalId,
  p_proposal_revision_id: proposalRevisionId,
};
const startArgs = {
  ...scopedArgs,
  p_request_id: command.requestId,
  p_targeted_suite_revision_id: command.targetedSuiteRevisionId,
  p_holdout_suite_revision_id: command.holdoutSuiteRevisionId,
  p_policy_revision_id: command.policyRevisionId,
  p_scorer_revision_id: command.scorerRevisionId,
  p_targeted_candidates: command.candidates,
  p_holdout_candidates: command.candidates,
  p_execution: command.execution,
  p_thresholds: command.thresholds,
};

function gateway(respond: () => Response | Promise<Response>, factoryVisible = true) {
  const calls: Array<{ rpc: string | undefined; actor: string | null; args: unknown }> = [];
  const user = createClient<Database>("https://fixture.invalid", "signed-user", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const target = new URL(input instanceof Request ? input.url : input);
        expect(target.pathname).toBe("/rest/v1/factories");
        expect(target.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(target.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json(factoryVisible ? { id: factoryId } : null);
      },
    },
  });
  const admin = createClient<Database>("https://fixture.invalid", "service-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, options) => {
        const request = new Request(input, options);
        calls.push({
          rpc: new URL(request.url).pathname.split("/").at(-1),
          actor: request.headers.get("Authorization"),
          args: await request.json(),
        });
        return respond();
      },
    },
  });
  mocks.access.mockResolvedValue({
    ok: true,
    context: { user: { id: actorUserId }, supabase: user },
  });
  mocks.admin.mockReturnValue(admin);
  return calls;
}

function start(
  body: unknown = command,
  headers: HeadersInit = { origin, "content-type": "application/json" },
) {
  return POST(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), context);
}

function get() {
  return GET(new Request(url), context);
}

describe("exact proposal validation API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    clearRateLimitsForTesting();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("starts the same ordered Workerd comparison on both suites and wakes dispatch after commit", async () => {
    const transaction = Promise.withResolvers<Response>();
    const calls = gateway(() => transaction.promise);
    const request = start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      rpc: "start_factory_improvement_validation",
      actor: "Bearer service-fixture",
      args: startArgs,
    });
    expect(mocks.wake).not.toHaveBeenCalled();
    transaction.resolve(Response.json({ validation: receipt, replay: false }));

    const response = await request;
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ validation: receipt });
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("replays both experiment identities without waking dispatch a second time", async () => {
    const responses = [false, true];
    const calls = gateway(() => Response.json({ validation: receipt, replay: responses.shift() }));
    const first = await start();
    const replay = await start();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ validation: receipt });
    expect(calls.map(({ args }) => args)).toEqual([startArgs, startArgs]);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing origin", { "content-type": "application/json" }],
    ["foreign origin", { "content-type": "application/json", origin: "https://elsewhere.test" }],
  ])("rejects a write with %s before it consumes scoped resources", async (_, headers) => {
    expect((await start(command, headers)).status).toBe(403);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it.each([
    ["forged actor", { ...command, actorUserId: id(99) }],
    ["same suite", { ...command, holdoutSuiteRevisionId: command.targetedSuiteRevisionId }],
    ["missing thresholds", { ...command, thresholds: undefined }],
    [
      "unqualified runtime",
      {
        ...command,
        candidates: [{ ...command.candidates[0], workerRuntime: "node" }, command.candidates[1]],
      },
    ],
    [
      "same definition twice",
      { ...command, candidates: [command.candidates[0], command.candidates[0]] },
    ],
  ])("rejects %s before starting a comparison", async (_, body) => {
    gateway(() => Response.json(null));
    expect((await start(body)).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("bounds request bytes and requires JSON before creating the privileged client", async () => {
    gateway(() => Response.json(null));
    expect((await start({ ...command, extra: "x".repeat(16 * 1024) })).status).toBe(413);
    expect((await start(command, { origin, "content-type": "text/plain" })).status).toBe(415);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("uses the existing scoped proposal rate limit before parsing or starting", async () => {
    gateway(() => Response.json(null));
    for (let count = 0; count < RATE_LIMITS.improvementProposals.max; count += 1) {
      await checkRateLimit("improvementProposals", `${workspaceId}:${actorUserId}`);
    }
    const response = await start({ invalid: true });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("uses the authenticated factory selection before opening either privileged RPC", async () => {
    const calls = gateway(() => Response.json(null), false);
    expect((await start()).status).toBe(404);
    expect((await get()).status).toBe(404);
    expect(calls).toEqual([]);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", 403],
    ["P0002", 404],
    ["PT409", 409],
    ["PT412", 412],
    ["PT422", 422],
  ])(
    "preserves admission code %s without exposing internal SQL text or waking dispatch",
    async (code, status) => {
      gateway(() =>
        Response.json({ code, message: "internal benchmark configuration" }, { status }),
      );
      const response = await start();
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("internal benchmark configuration");
      expect(mocks.wake).not.toHaveBeenCalled();
    },
  );

  it("reads scoped historical evidence without exposing stale qualification", async () => {
    const validation = { ...receipt, status: "stale", reasons: ["proposal_revision_changed"] };
    const calls = gateway(() => Response.json(validation));
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ validation });
    expect(calls).toEqual([
      {
        rpc: "get_factory_improvement_validation",
        actor: "Bearer service-fixture",
        args: scopedArgs,
      },
    ]);
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("preserves holdout regression and partial observations on the exact receipt", async () => {
    const validation = {
      ...receipt,
      status: "failed",
      reasons: ["holdout_failed"],
      holdout: {
        ...receipt.holdout,
        status: "failed",
        reasons: ["known_regression", "unknown_cost"],
        resolvedPairs: 2,
        coverageBps: 3333.3333,
        regressions: 1,
        baseline: { ...receipt.holdout.baseline, passRateBps: 8333.3333 },
      },
    };
    gateway(() => Response.json(validation));
    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ validation });
  });

  it("refuses an admission response whose baseline, suites, or thresholds were changed", async () => {
    gateway(() =>
      Response.json({
        validation: { ...receipt, thresholds: { ...command.thresholds, minimumCoverageBps: 1 } },
        replay: false,
      }),
    );
    expect((await start()).status).toBe(500);
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("does not return a different proposal revision or a missing comparison", async () => {
    gateway(() => Response.json({ ...receipt, proposalRevisionId: id(99) }));
    expect((await get()).status).toBe(500);
    gateway(() => Response.json(null));
    expect((await get()).status).toBe(404);
  });
});
