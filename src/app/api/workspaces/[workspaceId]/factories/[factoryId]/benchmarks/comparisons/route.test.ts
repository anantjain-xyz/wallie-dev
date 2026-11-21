import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BenchmarkComparison,
  BenchmarkComparisonTrial,
} from "@/lib/factory-benchmarks/comparison-contracts";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET as getComparison } from "../experiments/[experimentId]/comparison/route";
import { GET as getPart } from "../experiments/[experimentId]/exports/[exportId]/[section]/[part]/route";
import { GET as getManifest } from "../experiments/[experimentId]/exports/[exportId]/route";
import { GET as getExports, POST as postExport } from "../experiments/[experimentId]/exports/route";
import { GET as getFrontier } from "../experiments/[experimentId]/frontier/route";
import { GET as getComparisons } from "./route";

const id = (slot: number) => `62100000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const experimentId = id(4);
const exportId = id(5);
const requestId = id(6);
const factory = { workspaceId, factoryId };
const experiment = { ...factory, experimentId };
const exported = { ...experiment, exportId };
const experimentContext = { params: Promise.resolve(experiment) };
const createdAt = "2026-11-21T14:00:00.123456+00:00";
const expiresAt = "2026-11-22T14:00:00.123456+00:00";
const base = `https://factory.test/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks`;
const experimentUrl = `${base}/experiments/${experimentId}`;
const exportsUrl = `${experimentUrl}/exports`;
const candidateKey = "a".repeat(64);
const scorerRevisionId = id(8);
const suite = { id: id(9), revisionId: id(10), revisionNumber: 2, name: "Frozen suite" };
const scopeArgs = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_actor_user_id: actorUserId,
};
const experimentArgs = { ...scopeArgs, p_experiment_id: experimentId };

const zero = {
  measuredUsd: "0.000000",
  estimatedUsd: "0.000000",
  knownUsd: "0.000000",
  reservedUsd: "0.000000",
  unavailableHoldUsd: "0.000000",
  measuredAttemptCount: 0,
  estimatedAttemptCount: 0,
  unavailableAttemptCount: 0,
  pendingAttemptCount: 0,
  neverStartedAttemptCount: 0,
};
const measured = {
  ...zero,
  measuredUsd: "0.100001",
  knownUsd: "0.100001",
  measuredAttemptCount: 1,
};
const unavailable = {
  ...zero,
  unavailableHoldUsd: "0.200000",
  reservedUsd: "0.200000",
  unavailableAttemptCount: 1,
};
const estimate = {
  ...zero,
  estimatedUsd: "0.300009",
  knownUsd: "0.300009",
  estimatedAttemptCount: 1,
};
const rowSpend = (execution: typeof zero, evaluation = zero, combined = execution) => ({
  execution,
  evaluation,
  combined,
  costUnavailableTrialCount: execution.unavailableAttemptCount ? 1 : 0,
});
const counts = {
  planned: 8,
  eligible: 7,
  excluded: 1,
  admitted: 5,
  started: 4,
  pending: 1,
  running: 1,
  succeeded: 1,
  failed: 1,
  timedOut: 1,
  canceled: 1,
  unavailable: 1,
  terminal: 5,
};
const spend = rowSpend(
  {
    ...measured,
    ...unavailable,
    measuredUsd: measured.measuredUsd,
    knownUsd: measured.knownUsd,
    measuredAttemptCount: 1,
  },
  estimate,
  {
    ...measured,
    ...unavailable,
    measuredUsd: measured.measuredUsd,
    estimatedUsd: estimate.estimatedUsd,
    knownUsd: "0.400010",
    measuredAttemptCount: 1,
    estimatedAttemptCount: 1,
  },
);
const trialStatus = [
  "excluded",
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "unavailable",
] as const;
const scoreStatus = [
  "skipped",
  "pending",
  "pending",
  "pass",
  "error",
  "unavailable",
  "skipped",
  "inconclusive",
] as const;
const trialRows: BenchmarkComparisonTrial[] = trialStatus.map((status, index) => {
  const started = index >= 2 && index <= 5;
  const admitted = started || status === "unavailable";
  const completed = status === "succeeded";
  return {
    trialId: id(20 + index),
    task: { id: id(11), revisionId: id(12), revisionNumber: 1, name: "Captured checkout α" },
    candidateKey,
    candidatePosition: null,
    plannedHarness: "codex",
    plannedModel: "gpt-4.1-2025-04-14",
    repetition: index + 1,
    seed: 100 + index,
    timeoutMs: 120_000,
    eligibility: status === "excluded" ? "unverified" : "eligible",
    eligibilityReason: status === "excluded" ? "Exact source was unavailable" : null,
    status,
    reason: status === "timed_out" ? "deadline_elapsed" : null,
    admitted,
    started,
    runId: admitted ? id(30 + index) : null,
    startedAt: started ? createdAt : null,
    finishedAt: started && status !== "running" ? "2026-11-21T14:01:00+00:00" : null,
    deadlineAt: started ? "2026-11-21T14:02:00+00:00" : null,
    deadlineElapsed: status === "timed_out",
    wallRuntimeMs: completed ? 60_000 : null,
    resultDigest: completed ? "d".repeat(64) : null,
    actualRunner: started
      ? {
          runnerRevision: "recorded-fixture-v1",
          workerRuntime: completed ? "workerd" : null,
          modelProvider: null,
          modelName: null,
        }
      : null,
    spend: completed
      ? rowSpend(unavailable, estimate, {
          ...unavailable,
          knownUsd: estimate.knownUsd,
          estimatedUsd: estimate.estimatedUsd,
          estimatedAttemptCount: 1,
        })
      : rowSpend(status === "failed" ? measured : zero),
    scores:
      status === "excluded"
        ? []
        : [
            {
              scorerRevisionId,
              status: scoreStatus[index],
              reason: status === "timed_out" ? "execution_unavailable" : null,
              attemptId: completed ? id(44) : null,
              score: completed ? { kind: "boolean", value: true } : null,
            },
          ],
  };
});
const listing = {
  experimentId,
  createdAt,
  suite,
  repetitions: 8,
  counts,
  scheduleState: "active" as const,
};
const summary: Omit<
  BenchmarkComparison,
  "trialRows" | "nextCursor" | "candidates" | "nextCandidateCursor"
> = {
  ...listing,
  policyRevisionId: id(13),
  policyDigest: "b".repeat(64),
  seed: 100,
  timeoutMs: 120_000,
  spend,
  scorers: [
    {
      id: scorerRevisionId,
      scorerId: id(14),
      revisionNumber: 2,
      name: "Frozen rubric",
      definitionDigest: "e".repeat(64),
    },
  ],
  candidateCount: 1,
};
const candidates: BenchmarkComparison["candidates"] = [
  {
    candidateKey,
    position: null,
    definitionRevisionId: id(15),
    definitionDigest: "c".repeat(64),
    qualificationId: null,
    plannedHarness: "codex",
    plannedModel: "gpt-4.1-2025-04-14",
    plannedRuntime: "workerd",
    sandboxProvider: "vercel",
    sandboxConnectionRevision: id(16),
    canonicalModelKey: null,
    toolchain: null,
    toolchainDigest: null,
    counts,
    spend,
    latency: { sampleCount: 1, medianMs: 60_000, p95Ms: 60_000 },
    quality: [
      {
        scorerRevisionId,
        denominator: 7,
        pending: 2,
        pass: 1,
        fail: 0,
        inconclusive: 1,
        skipped: 1,
        error: 1,
        unavailable: 1,
      },
    ],
  },
];
const fullComparison = {
  ...summary,
  candidates,
  trialRows,
  nextCursor: null,
  nextCandidateCursor: null,
};
const receipt = {
  exportId,
  capturedAt: createdAt,
  expiresAt,
  trialCount: counts.planned,
  pageCount: 1,
  candidateCount: 1,
  candidatePageCount: 1,
};
const retainedPage = JSON.stringify(
  { schemaVersion: 1, exportId, ordinal: 1, kind: "trials", trialRows },
  null,
  2,
);
const retainedCandidatePage = JSON.stringify(
  { schemaVersion: 1, exportId, ordinal: 1, kind: "candidates", candidates },
  null,
  2,
);
const retainedManifest = JSON.stringify({
  schemaVersion: 1,
  exportId,
  ...experiment,
  capturedAt: createdAt,
  expiresAt,
  summary,
  trialIds: trialRows.map(({ trialId }) => trialId),
  pages: [
    {
      ordinal: 1,
      firstTrialId: trialRows.at(0)?.trialId,
      lastTrialId: trialRows.at(-1)?.trialId,
      trialCount: trialRows.length,
      sha256: createHash("sha256").update(retainedPage).digest("hex"),
      sizeBytes: Buffer.byteLength(retainedPage),
    },
  ],
  candidatePages: [
    {
      ordinal: 1,
      firstCandidateKey: candidateKey,
      lastCandidateKey: candidateKey,
      candidateCount: candidates.length,
      sha256: createHash("sha256").update(retainedCandidatePage).digest("hex"),
      sizeBytes: Buffer.byteLength(retainedCandidatePage),
    },
  ],
});

function setup(serve: (rpcName: string, args: unknown) => Response) {
  const rpc = vi.fn(serve);
  const supabase = createClient<Database>("https://factory.test", "reader", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/factories");
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json({ id: factoryId });
      },
    },
  });
  const admin = createClient<Database>("https://factory.test", "writer", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return rpc(url.pathname.split("/").at(-1) ?? "", JSON.parse(String(init?.body)));
      },
    },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: actorUserId }, supabase } });
  mocks.admin.mockReturnValue(admin);
  return rpc;
}

describe("benchmark comparison endpoints", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses an exact scoped descending cursor and frozen suite revision", async () => {
    const rpc = setup(() => Response.json({ items: [listing], nextCursor: null }));
    const url = new URL(`${base}/comparisons`);
    url.search = new URLSearchParams({
      suiteRevisionId: suite.revisionId,
      beforeCreatedAt: createdAt,
      beforeExperimentId: id(19),
      limit: "24",
    }).toString();
    const response = await getComparisons(new Request(url), { params: Promise.resolve(factory) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ items: [listing], nextCursor: null });
    expect(rpc).toHaveBeenCalledWith("list_factory_benchmark_comparisons", {
      ...scopeArgs,
      p_suite_revision_id: suite.revisionId,
      p_before_created_at: createdAt,
      p_before_experiment_id: id(19),
      p_limit: 24,
    });
  });

  it("uses the signed-in actor with exact frontier constraints and a private cursor", async () => {
    const scorer = { id: scorerRevisionId, scorerId: id(14), revisionNumber: 2, name: "Rubric" };
    const rpc = setup(() =>
      Response.json({
        experimentId,
        snapshotAt: createdAt,
        suite,
        policy: {
          revision: "measured-usd-v1",
          qualityFloorBps: 8501,
          minimumResolved: 3,
          costBasis: "execution_plus_selected_judge",
        },
        scorer,
        scorers: [scorer],
        cohort: {
          plannedTrialCount: 4,
          eligibleTrialCount: 0,
          excludedTrialCount: 4,
          eligibleSlotCount: 0,
          taskRevisionCount: 0,
          repetitions: 2,
        },
        candidateCount: 2,
        frontierCount: 0,
        recommendation: {
          status: "unavailable",
          reason: "no_eligible_trials",
          candidates: [],
          candidateCount: 0,
          meanCostUsd: null,
          passRateBps: null,
        },
        items: [],
        nextCursor: null,
      }),
    );
    const url = new URL(`${experimentUrl}/frontier`);
    url.search = new URLSearchParams({
      scorerRevisionId,
      afterCandidateKey: candidateKey,
      qualityFloorBps: "8501",
      minResolvedTrials: "3",
      limit: "16",
    }).toString();

    const response = await getFrontier(new Request(url), experimentContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_benchmark_frontier", {
      ...experimentArgs,
      p_scorer_revision_id: scorerRevisionId,
      p_after_candidate_key: candidateKey,
      p_quality_floor_bps: 8501,
      p_min_resolved_trials: 3,
      p_limit: 16,
    });
  });

  it("rejects ambiguous frontier constraints and enforces the factory manager result", async () => {
    const rpc = setup(() => Response.json({ code: "42501" }, { status: 403 }));
    const url = `${experimentUrl}/frontier`;
    for (const query of ["qualityFloorBps=10001", "minResolvedTrials=1", "limit=3&limit=2"]) {
      const response = await getFrontier(new Request(`${url}?${query}`), experimentContext);
      expect(response.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();

    const denied = await getFrontier(new Request(url), experimentContext);
    expect(denied.status).toBe(403);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_benchmark_frontier", {
      ...experimentArgs,
      p_quality_floor_bps: 8000,
      p_min_resolved_trials: 2,
      p_limit: 50,
    });
  });

  it("reconciles every frozen row, with unsuccessful outcomes and unavailable cost still visible", async () => {
    const rpc = setup(() => Response.json(fullComparison));
    const response = await getComparison(
      new Request(`${experimentUrl}/comparison?limit=8`),
      experimentContext,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.counts).toEqual(counts);
    expect(body.trialRows.map((row: BenchmarkComparisonTrial) => row.status)).toEqual(trialStatus);
    expect(body.trialRows[3].spend).toMatchObject({
      execution: {
        knownUsd: "0.000000",
        unavailableAttemptCount: 1,
        unavailableHoldUsd: "0.200000",
      },
      evaluation: { knownUsd: "0.300009" },
      costUnavailableTrialCount: 1,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_benchmark_comparison", {
      ...experimentArgs,
      p_limit: 8,
      p_candidate_limit: 50,
    });
  });

  it("paginates configurations and trials independently while retaining full matrix totals", async () => {
    const candidateCount = 66;
    const totals = Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, value * candidateCount]),
    );
    const offPageCandidate = "f".repeat(64);
    const offPageLabel = {
      candidateKey: offPageCandidate,
      candidatePosition: 42,
      plannedHarness: "opencode",
      plannedModel: "openai/gpt-4.1-2025-04-14",
    };
    const rpc = setup(() =>
      Response.json({
        ...fullComparison,
        candidateCount,
        counts: totals,
        trialRows: [{ ...trialRows[1], ...offPageLabel }],
        nextCursor: { trialId: id(21) },
        nextCandidateCursor: { candidateKey },
      }),
    );
    const url = new URL(`${experimentUrl}/comparison`);
    const earlierCandidate = "9".repeat(64);
    url.search = new URLSearchParams({
      afterTrialId: id(20),
      afterCandidateKey: earlierCandidate,
      candidateLimit: "1",
      limit: "1",
    }).toString();
    const response = await getComparison(new Request(url), experimentContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      candidateCount,
      counts: { planned: 528 },
      candidates: [{ candidateKey }],
      trialRows: [{ trialId: id(21), ...offPageLabel }],
      nextCursor: { trialId: id(21) },
      nextCandidateCursor: { candidateKey },
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_benchmark_comparison", {
      ...experimentArgs,
      p_after_trial_id: id(20),
      p_limit: 1,
      p_after_candidate_key: earlierCandidate,
      p_candidate_limit: 1,
    });
  });

  it("rejects ambiguous cursors before a privileged call and propagates current manager requirements", async () => {
    const rpc = setup(() =>
      Response.json({ code: "42501", message: "private detail" }, { status: 403 }),
    );
    const first = await getComparison(
      new Request(`${experimentUrl}/comparison?limit=7&limit=8`),
      experimentContext,
    );
    expect(first.status).toBe(400);
    const second = await getExports(
      new Request(`${exportsUrl}?beforeExportId=${exportId}`),
      experimentContext,
    );
    expect(second.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();

    const denied = await getComparison(
      new Request(`${experimentUrl}/comparison?afterTrialId=${id(20)}`),
      experimentContext,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "Factory manager access is required." });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_benchmark_comparison", {
      ...experimentArgs,
      p_after_trial_id: id(20),
      p_limit: 50,
      p_candidate_limit: 50,
    });
  });

  it("fails closed when the database projection drops terminal outcomes or references another experiment", async () => {
    const rpc = setup(() =>
      Response.json({
        ...fullComparison,
        counts: { ...counts, canceled: 0 },
      }),
    );
    const url = `${experimentUrl}/comparison`;
    expect((await getComparison(new Request(url), experimentContext)).status).toBe(500);
    rpc.mockImplementationOnce(() => Response.json({ ...fullComparison, experimentId: id(99) }));
    expect((await getComparison(new Request(url), experimentContext)).status).toBe(500);
  });

  it("creates a private request-idempotent export and scopes history to the same actor", async () => {
    const rpc = setup((name) =>
      Response.json(
        name === "create_factory_benchmark_comparison_export"
          ? receipt
          : { experimentId, items: [receipt], nextCursor: null },
      ),
    );
    for (const method of ["POST", "POST"] as const) {
      const captured = await postExport(
        new Request(exportsUrl, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        }),
        experimentContext,
      );
      expect(captured.status).toBe(201);
      await expect(captured.json()).resolves.toEqual(receipt);
    }
    const response = await getExports(new Request(exportsUrl), experimentContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      experimentId,
      items: [receipt],
      nextCursor: null,
    });
    expect(rpc.mock.calls).toEqual([
      [
        "create_factory_benchmark_comparison_export",
        { ...experimentArgs, p_request_id: requestId },
      ],
      [
        "create_factory_benchmark_comparison_export",
        { ...experimentArgs, p_request_id: requestId },
      ],
      ["list_factory_benchmark_comparison_exports", { ...experimentArgs, p_limit: 20 }],
    ]);
  });

  it("returns the active-export limit without exposing database details", async () => {
    setup(() =>
      Response.json({ code: "PT429", message: "private limit details" }, { status: 429 }),
    );
    const response = await postExport(
      new Request(exportsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      }),
      experimentContext,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "The factory has too many active benchmark exports.",
    });
  });

  it("downloads the exact retained UTF-8 bytes with reconciled IDs and page hash", async () => {
    const rpc = setup((_name, args) =>
      Response.json(
        typeof args === "object" && args !== null && "p_page_ordinal" in args
          ? "p_page_kind" in args && args.p_page_kind === "candidates"
            ? retainedCandidatePage
            : retainedPage
          : retainedManifest,
      ),
    );
    const manifest = await getManifest(new Request(`${exportsUrl}/${exportId}`), {
      params: Promise.resolve(exported),
    });
    const page = await getPart(new Request(`${exportsUrl}/${exportId}/parts/1`), {
      params: Promise.resolve({ ...exported, section: "parts", part: "1" }),
    });

    const candidatePage = await getPart(
      new Request(`${exportsUrl}/${exportId}/candidate-parts/1`),
      {
        params: Promise.resolve({ ...exported, section: "candidate-parts", part: "1" }),
      },
    );
    for (const response of [manifest, page, candidatePage]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Disposition")).toContain("attachment");
    }
    const manifestBody = await manifest.text();
    const pageBody = await page.text();
    expect(manifestBody).toBe(retainedManifest);
    expect(pageBody).toBe(retainedPage);
    expect(await candidatePage.text()).toBe(retainedCandidatePage);
    expect(JSON.parse(manifestBody).trialIds).toEqual(trialRows.map(({ trialId }) => trialId));
    expect(JSON.parse(manifestBody).pages[0].sha256).toBe(
      createHash("sha256").update(pageBody).digest("hex"),
    );
    expect(rpc.mock.calls).toEqual([
      ["read_factory_benchmark_comparison_export", { ...experimentArgs, p_export_id: exportId }],
      [
        "read_factory_benchmark_comparison_export",
        { ...experimentArgs, p_export_id: exportId, p_page_ordinal: 1, p_page_kind: "trials" },
      ],
      [
        "read_factory_benchmark_comparison_export",
        { ...experimentArgs, p_export_id: exportId, p_page_ordinal: 1, p_page_kind: "candidates" },
      ],
    ]);
  });

  it("does not leak a stored cross-experiment manifest and handles expired downloads", async () => {
    const wrongManifest = JSON.stringify({ ...JSON.parse(retainedManifest), factoryId: id(99) });
    const rpc = setup(() => Response.json(wrongManifest));
    const request = new Request(`${exportsUrl}/${exportId}`);
    const context = { params: Promise.resolve(exported) };
    const wrong = await getManifest(request, context);
    expect(wrong.status).toBe(500);
    expect(await wrong.text()).not.toContain(id(99));

    rpc.mockImplementationOnce(() =>
      Response.json({ code: "PT410", message: "private row" }, { status: 410 }),
    );
    const expired = await getManifest(request, context);
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toEqual({ error: "The benchmark export expired." });

    const outOfRange = await getPart(request, {
      params: Promise.resolve({ ...exported, section: "parts", part: "314" }),
    });
    expect(outOfRange.status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("rejects a retained trial payload returned for a configuration part", async () => {
    setup(() => Response.json(retainedPage));
    const response = await getPart(new Request(`${exportsUrl}/${exportId}/candidate-parts/1`), {
      params: Promise.resolve({ ...exported, section: "candidate-parts", part: "1" }),
    });
    expect(response.status).toBe(500);
    expect(response.headers.has("Content-Disposition")).toBe(false);
  });
});
