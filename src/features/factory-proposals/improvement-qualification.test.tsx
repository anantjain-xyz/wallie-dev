import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import type { FactoryImprovementValidationReceipt } from "@/lib/factory-proposals/validation-contracts";
import { readFactoryImprovementValidation } from "@/lib/factory-proposals/validation-server";

import { ImprovementQualification } from "./improvement-qualification";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/lib/factory-proposals/validation-server", () => ({
  readFactoryImprovementValidation: vi.fn(),
}));
const read = vi.mocked(readFactoryImprovementValidation);

const id = (slot: number) => `63800000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const proposalId = id(1);
const proposalRevisionId = id(2);
const targetedRevisionId = id(3);
const holdoutRevisionId = id(4);
const targetedExperimentId = id(5);
const holdoutExperimentId = id(6);

function receipt(
  status: FactoryImprovementValidationReceipt["status"],
  pending = false,
): FactoryImprovementValidationReceipt {
  const base = { activationNumber: 3, revisionId: id(7), digest: "a".repeat(64) };
  const candidate = { revisionId: id(8), digest: "b".repeat(64) };
  const baseline = {
    candidateKey: "c".repeat(64),
    plannedTrials: 6,
    resolvedTrials: 6,
    passes: 6,
    measuredCostTrials: 6,
    measuredLatencyTrials: 6,
    passRateBps: 10_000,
    meanCostUsd: 0.05,
    p95LatencyMs: 1500,
  };
  const comparison = {
    suiteRevisionId: targetedRevisionId,
    experimentId: targetedExperimentId,
    scheduleState: "active",
    status: status === "stale" ? "inconclusive" : status,
    reasons: [],
    independentTasks: 2,
    plannedPairs: 6,
    resolvedPairs: 6,
    coverageBps: 10_000,
    regressions: 0,
    baseline,
    candidate: { ...baseline, candidateKey: "d".repeat(64) },
  } satisfies FactoryImprovementValidationReceipt["targeted"];
  return {
    id: id(9),
    proposalId,
    proposalRevisionId,
    requestId: id(10),
    authorMemberId: id(11),
    createdAt: "2026-11-22T05:00:00Z",
    asOf: "2026-11-22T05:01:00Z",
    base,
    candidate,
    policyRevisionId: id(12),
    scorerRevisionId: id(13),
    axes: [
      { definitionRevisionId: base.revisionId, qualificationId: id(14), workerRuntime: "workerd" },
      {
        definitionRevisionId: candidate.revisionId,
        qualificationId: id(15),
        workerRuntime: "workerd",
      },
    ],
    execution: {
      repetitions: 3,
      seed: 74,
      timeoutMs: 120_000,
      inferenceConnectionRevision: id(16),
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
    status,
    reasons: status === "stale" ? ["stale_proposal"] : [],
    targeted: {
      ...comparison,
      reasons: pending ? ["pending_work"] : [],
      resolvedPairs: pending ? 2 : 6,
    },
    holdout: {
      ...comparison,
      suiteRevisionId: holdoutRevisionId,
      experimentId: holdoutExperimentId,
    },
  };
}

async function qualification(canManage = true) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({
      data: [
        { id: targetedRevisionId, suite_id: "targeted-suite" },
        { id: holdoutRevisionId, suite_id: "held-out-suite" },
      ],
    }),
  };
  const scope = {
    factory: { canManage },
    factoryId: "fixture-factory",
    workspaceId: "fixture-workspace",
    actorUserId: "fixture-actor",
    supabase: { from: vi.fn().mockReturnValue(query) },
  } as unknown as Parameters<typeof ImprovementQualification>[0]["scope"];
  const section = await ImprovementQualification({
    scope,
    workspaceSlug: "test",
    proposalId,
    proposalRevisionId,
  });
  return { html: renderToStaticMarkup(section), query };
}

beforeEach(() => read.mockReset());

it("shows qualification and both pinned comparisons without a publication", async () => {
  read.mockResolvedValue(receipt("qualified"));
  const { html, query } = await qualification();
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "fixture-workspace",
      factoryId: "fixture-factory",
      actorUserId: "fixture-actor",
      proposalId,
      proposalRevisionId,
    }),
  );
  expect(query.eq.mock.calls).toEqual([
    ["workspace_id", "fixture-workspace"],
    ["factory_id", "fixture-factory"],
  ]);
  expect(query.in).toHaveBeenCalledWith("id", [targetedRevisionId, holdoutRevisionId]);
  expect(html).toContain("Both benchmark comparisons met the recorded thresholds.");
  expect(html).toContain(
    `/targeted-suite/comparisons/${targetedExperimentId}?factory=fixture-factory`,
  );
  expect(html).toContain(
    `/held-out-suite/comparisons/${holdoutExperimentId}?factory=fixture-factory`,
  );
  expect(html).toContain("of 6 pairs resolved");
});

it("keeps missing and unavailable distinct and does not read evidence for viewers", async () => {
  expect((await qualification(false)).html).toBe("");
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Unavailable"));
  expect((await qualification()).html).toContain("No benchmark comparison was recorded");
  expect((await qualification()).html).toContain("Could not load benchmark qualification");
});

it.each([
  ["inconclusive", true, "Benchmark work is still pending."],
  ["inconclusive", false, "Inconclusive"],
  ["failed", true, "Failed"],
  ["stale", true, "A newer proposal revision exists."],
] as const)(
  "labels %s receipts independently of pending work (%s)",
  async (status, pending, expected) => {
    read.mockResolvedValue(receipt(status, pending));
    expect((await qualification()).html).toContain(expected);
  },
);
