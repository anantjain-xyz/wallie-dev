import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";
import { drainAcceptedTriageRoute } from "@/lib/factory-workflows/triage-dispatch";
import { reconcilePrReadiness } from "@/lib/pipeline/pr-readiness";
import { sweepStalledRuns } from "@/worker/stall-detector";
import { drainCanonicalPullRequests } from "@/lib/pipeline/canonical-pr-publisher";
import { drainFactoryWorkflowRepositoryDeliveries } from "@/lib/factory-workflows/repository-delivery";
import { drainFactoryWorkflowBranches } from "@/lib/factory-workflows/branch-dispatch";
import {
  drainExactFactoryWorkflowReview,
  drainExactFactoryWorkflowReviewRepair,
  expireExactFactoryWorkflowReview,
} from "@/lib/factory-workflows/exact-review-runtime";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";
import { cleanupRunExports, drainRunExports } from "@/lib/run-exports/worker";
import { drainRunRetention } from "@/lib/run-retention/maintenance";
import { pruneFactoryOAuthCredentials } from "@/lib/factory-oauth/maintenance";
import { pruneFactoryCommandAdmissions } from "@/lib/factory-command-authorization/maintenance";
import { drainFactoryDiagnoses } from "@/lib/factory-diagnosis/worker";
import { drainFactoryJudges } from "@/lib/factory-evaluations/judge-worker";
import { pruneFactoryEventOutbox } from "@/lib/factory-event-subscriptions/maintenance";
import { requestFactoryEventDispatch } from "@/lib/factory-event-subscriptions/relay";
import { drainFactoryWorkflowSandboxStops } from "@/lib/factory-workflows/sandbox-stop-drain";
import type { Env } from "../index";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/features/github/pr-verification-service", () => ({
  reconcileGitHubPrVerification: vi.fn(),
}));
vi.mock("@/lib/pipeline/pr-readiness", () => ({ reconcilePrReadiness: vi.fn() }));
vi.mock("@/lib/factory-workflows/triage-dispatch", () => ({ drainAcceptedTriageRoute: vi.fn() }));
vi.mock("@/lib/pipeline/canonical-pr-publisher", () => ({ drainCanonicalPullRequests: vi.fn() }));
vi.mock("@/lib/pipeline/checkpoint-publication", () => ({ drainCheckpointPublications: vi.fn() }));
vi.mock("@/lib/pipeline/source-delivery", () => ({ drainSourceDeliveries: vi.fn() }));
vi.mock("@/lib/pipeline/checkpoint-cleanup", () => ({ drainCheckpointCleanup: vi.fn() }));
vi.mock("@/worker/stall-detector", () => ({ sweepStalledRuns: vi.fn() }));
vi.mock("@/worker/reconciler", () => ({ reconcileLinearState: vi.fn() }));
vi.mock("@/worker/sandbox-reaper", () => ({ reapOrphanSandboxes: vi.fn() }));
vi.mock("@/lib/factory-workflows/sandbox-stop-drain", () => ({
  drainFactoryWorkflowSandboxStops: vi.fn(),
}));
vi.mock("@/lib/storage/session-attachment-cleanup", () => ({
  cleanupExpiredSessionAttachments: vi.fn(),
}));
vi.mock("@/lib/run-retention/maintenance", () => ({ drainRunRetention: vi.fn() }));
vi.mock("@/lib/factory-oauth/maintenance", () => ({ pruneFactoryOAuthCredentials: vi.fn() }));
vi.mock("@/lib/factory-command-authorization/maintenance", () => ({
  pruneFactoryCommandAdmissions: vi.fn(),
}));
vi.mock("@/lib/factory-diagnosis/worker", () => ({ drainFactoryDiagnoses: vi.fn() }));
vi.mock("@/lib/factory-evaluations/judge-worker", () => ({ drainFactoryJudges: vi.fn() }));
vi.mock("@/lib/factory-event-subscriptions/maintenance", () => ({
  pruneFactoryEventOutbox: vi.fn(),
}));
vi.mock("@/lib/factory-event-subscriptions/relay", () => ({
  requestFactoryEventDispatch: vi.fn(),
}));
vi.mock("@/lib/factory-workflows/repository-delivery", () => ({
  drainFactoryWorkflowRepositoryDeliveries: vi.fn(),
}));
vi.mock("@/lib/factory-workflows/branch-dispatch", () => ({
  drainFactoryWorkflowBranches: vi.fn(),
}));
vi.mock("@/lib/factory-workflows/exact-review-runtime", () => ({
  drainExactFactoryWorkflowReview: vi.fn(),
  drainExactFactoryWorkflowReviewRepair: vi.fn(),
  expireExactFactoryWorkflowReview: vi.fn(),
}));
vi.mock("@/lib/workspaces/deletion", () => ({ resumePendingWorkspaceDeletions: vi.fn() }));
vi.mock("@/lib/run-exports/worker", () => ({
  cleanupRunExports: vi.fn(),
  drainRunExports: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it.each([
  { scenario: "all tasks succeed" },
  { scenario: "accepted triage routing fails", triageFailure: true },
  { scenario: "exact workflow review fails", exactReviewFailure: true },
  { scenario: "GitHub verification fails", githubFailure: true },
  { scenario: "readiness fails", readinessFailure: true },
  {
    scenario: "several existing tasks fail",
    githubFailure: true,
    readinessFailure: true,
    oauthCleanupFailure: true,
    commandCleanupFailure: true,
    projectionFailure: true,
  },
  { scenario: "scorer sampling fails", samplingFailure: true },
  { scenario: "evaluation maintenance fails", evaluationFailure: true },
  { scenario: "failure cohort processing fails", failureCohortProcessingFailure: true },
  { scenario: "routing canary alert evaluation fails", canaryAlertFailure: true },
  { scenario: "benchmark scheduling fails", benchmarkFailure: true },
  { scenario: "a judge dispatch fails", judgeFailure: true },
  { scenario: "a workflow sandbox stop fails", sandboxStopFailure: true },
])(
  "runs independent maintenance when $scenario",
  async ({
    triageFailure,
    exactReviewFailure,
    githubFailure,
    readinessFailure,
    oauthCleanupFailure,
    commandCleanupFailure,
    projectionFailure,
    samplingFailure,
    evaluationFailure,
    failureCohortProcessingFailure,
    canaryAlertFailure,
    benchmarkFailure,
    judgeFailure,
    sandboxStopFailure,
  }) => {
    const bindings = env as unknown as Env;
    const id = `maintenance-${crypto.randomUUID()}`;
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      in: () => query,
      then(resolve: (value: { data: never[]; count: number; error: null }) => unknown) {
        return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
      },
    };
    const sample = vi.fn().mockResolvedValue(
      samplingFailure
        ? { data: null, error: { message: "Sampling temporarily unavailable" } }
        : {
            data: { candidate_count: 3, eligible_count: 2, sampled_count: 1, excluded_count: 1 },
            error: null,
          },
    );
    const evaluations = vi.fn().mockResolvedValue(
      evaluationFailure
        ? { data: null, error: { message: "Evaluation queue temporarily unavailable" } }
        : {
            data: {
              receipts_processed: 4,
              jobs_admitted: 2,
              attempts_recovered: 3,
              jobs_requeued: 2,
              jobs_failed: 1,
            },
            error: null,
          },
    );
    const rpc = vi.fn((name: string) => {
      if (name === "reconcile_factory_benchmark_schedules") {
        return {
          abortSignal: () =>
            Promise.resolve(
              benchmarkFailure
                ? { data: null, error: { message: "Benchmark scheduling temporarily unavailable" } }
                : { data: 3, error: null },
            ),
        };
      }
      if (name === "reconcile_factory_benchmark_evaluations") {
        return { abortSignal: () => Promise.resolve({ data: 2, error: null }) };
      }
      if (name === "process_factory_scorer_sampling") {
        return { abortSignal: () => ({ single: sample }) };
      }
      if (name === "maintain_factory_evaluation_queue") {
        return { abortSignal: () => ({ single: evaluations }) };
      }
      if (name === "process_factory_failure_cohorts") {
        return {
          abortSignal: () =>
            Promise.resolve(
              failureCohortProcessingFailure
                ? { data: null, error: { message: "Failure cohort processing unavailable" } }
                : { data: 2, error: null },
            ),
        };
      }
      if (name === "process_factory_routing_canary_alerts") {
        return {
          abortSignal: () =>
            Promise.resolve(
              canaryAlertFailure
                ? { data: null, error: { message: "Routing alert evaluation unavailable" } }
                : { data: { evaluated: 2, created: 1 }, error: null },
            ),
        };
      }
      return {
        abortSignal: () =>
          Promise.resolve(
            name === "prune_factory_analytics_exports"
              ? { data: 1, error: null }
              : projectionFailure
                ? { data: null, error: { message: "Projection temporarily unavailable" } }
                : { data: { processed: 25, hasMore: true }, error: null },
          ),
      };
    });
    const admin = { from: () => query, rpc };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
    if (triageFailure)
      vi.mocked(drainAcceptedTriageRoute).mockRejectedValue(
        new Error("Triage routing unavailable."),
      );
    if (exactReviewFailure)
      vi.mocked(drainExactFactoryWorkflowReview).mockRejectedValue(
        new Error("Review permit is unavailable."),
      );
    if (judgeFailure)
      vi.mocked(drainFactoryJudges).mockRejectedValue(new Error("Judge dispatch unavailable."));
    if (githubFailure)
      vi.mocked(reconcileGitHubPrVerification).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
    else
      vi.mocked(reconcileGitHubPrVerification).mockResolvedValue({
        checked: 1,
        refreshed: 1,
        failed: 0,
      });
    if (readinessFailure)
      vi.mocked(reconcilePrReadiness).mockRejectedValue(new Error("temporarily unavailable"));
    else
      vi.mocked(reconcilePrReadiness).mockResolvedValue({
        evaluated: 1,
        recorded: 1,
        failed: 0,
      });
    if (oauthCleanupFailure)
      vi.mocked(pruneFactoryOAuthCredentials).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
    if (commandCleanupFailure) {
      vi.mocked(pruneFactoryCommandAdmissions).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
      vi.mocked(requestFactoryEventDispatch).mockRejectedValue(
        new Error("relay temporarily unavailable"),
      );
    }
    if (sandboxStopFailure)
      vi.mocked(drainFactoryWorkflowSandboxStops).mockRejectedValue(
        new Error("Provider stop temporarily unavailable"),
      );
    const inspection = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
    try {
      await bindings.MAINTENANCE.create({ id, params: { tick: Date.now() } });
      await inspection.waitForStatus("complete");
      expect(drainAcceptedTriageRoute).toHaveBeenCalledExactlyOnceWith(admin);
      expect(reconcileGitHubPrVerification).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainCanonicalPullRequests).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(drainAcceptedTriageRoute).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(drainCanonicalPullRequests).mock.invocationCallOrder[0],
      );
      expect(vi.mocked(drainCanonicalPullRequests).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reconcileGitHubPrVerification).mock.invocationCallOrder[0],
      );
      expect(reconcilePrReadiness).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(reconcileGitHubPrVerification).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reconcilePrReadiness).mock.invocationCallOrder[0],
      );
      expect(sweepStalledRuns).toHaveBeenCalledExactlyOnceWith(admin, 900_000);
      expect(drainFactoryWorkflowSandboxStops).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(reconcilePrReadiness).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sweepStalledRuns).mock.invocationCallOrder[0],
      );
      expect(drainFactoryWorkflowBranches).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainFactoryWorkflowRepositoryDeliveries).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainExactFactoryWorkflowReview).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainExactFactoryWorkflowReviewRepair).toHaveBeenCalledExactlyOnceWith(admin);
      expect(expireExactFactoryWorkflowReview).toHaveBeenCalledExactlyOnceWith(admin);
      expect(cleanupExpiredSessionAttachments).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainRunRetention).toHaveBeenCalledExactlyOnceWith(admin);
      expect(pruneFactoryOAuthCredentials).toHaveBeenCalledExactlyOnceWith(admin);
      expect(pruneFactoryCommandAdmissions).toHaveBeenCalledExactlyOnceWith(admin);
      expect(requestFactoryEventDispatch).toHaveBeenCalledOnce();
      expect(pruneFactoryEventOutbox).toHaveBeenCalledExactlyOnceWith(admin);
      expect(rpc).toHaveBeenNthCalledWith(1, "reconcile_factory_benchmark_schedules", {
        p_limit: 25,
      });
      expect(vi.mocked(sweepStalledRuns).mock.invocationCallOrder[0]).toBeLessThan(
        rpc.mock.invocationCallOrder[0],
      );
      expect(rpc).toHaveBeenNthCalledWith(2, "reconcile_factory_benchmark_evaluations", {
        p_limit: 25,
      });
      expect(rpc).toHaveBeenNthCalledWith(3, "process_factory_flow_projection", {
        p_limit: 25,
      });
      expect(rpc).toHaveBeenNthCalledWith(4, "process_factory_scorer_sampling", { p_limit: 25 });
      expect(sample).toHaveBeenCalledOnce();
      expect(rpc).toHaveBeenNthCalledWith(5, "maintain_factory_evaluation_queue", { p_limit: 25 });
      expect(evaluations).toHaveBeenCalledOnce();
      expect(rpc).toHaveBeenNthCalledWith(6, "process_factory_failure_cohorts", {
        p_batch_size: 100,
      });
      expect(rpc).toHaveBeenNthCalledWith(7, "process_factory_routing_canary_alerts", {
        p_limit: 8,
      });
      expect(rpc).toHaveBeenNthCalledWith(8, "prune_factory_analytics_exports", { p_limit: 100 });
      expect(vi.mocked(sweepStalledRuns).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(cleanupExpiredSessionAttachments).mock.invocationCallOrder[0],
      );
      expect(drainRunExports).toHaveBeenCalledExactlyOnceWith(admin);
      expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(drainRunExports).mock.invocationCallOrder[0],
      );
      expect(cleanupRunExports).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainFactoryJudges).toHaveBeenCalledExactlyOnceWith(admin, "workerd");
      expect(drainFactoryDiagnoses).toHaveBeenCalledExactlyOnceWith(admin, "workerd");
      expect(vi.mocked(cleanupRunExports).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(drainFactoryJudges).mock.invocationCallOrder[0],
      );
    } finally {
      await inspection.dispose();
    }
  },
);
