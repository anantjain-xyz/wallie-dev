import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { startCursorAuthProcessor } from "@/lib/cursor/auth-processor";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";
import { drainSourceDeliveries } from "@/lib/pipeline/source-delivery";
import { drainCanonicalPullRequests } from "@/lib/pipeline/canonical-pr-publisher";
import { reconcilePrReadiness } from "@/lib/pipeline/pr-readiness";
import { drainAcceptedTriageRoute } from "@/lib/factory-workflows/triage-dispatch";
import { drainAuthoredFactoryWorkflowEntry } from "@/lib/factory-workflows/authoring-dispatch";
import { drainFactoryWorkflowRepositoryDeliveries } from "@/lib/factory-workflows/repository-delivery";
import { drainFactoryWorkflowBranches } from "@/lib/factory-workflows/branch-dispatch";
import {
  drainExactFactoryWorkflowReview,
  drainExactFactoryWorkflowReviewRepair,
  expireExactFactoryWorkflowReview,
} from "@/lib/factory-workflows/exact-review-runtime";
import { drainCheckpointPublications } from "@/lib/pipeline/checkpoint-publication";
import { drainFactoryWorkflowSandboxStops } from "@/lib/factory-workflows/sandbox-stop-drain";
import { drainCheckpointCleanup } from "@/lib/pipeline/checkpoint-cleanup";
import { cleanupRunExports, drainRunExports } from "@/lib/run-exports/worker";
import { drainRunRetention } from "@/lib/run-retention/maintenance";
import { pruneFactoryOAuthCredentials } from "@/lib/factory-oauth/maintenance";
import { pruneFactoryCommandAdmissions } from "@/lib/factory-command-authorization/maintenance";
import { drainFactoryDiagnoses } from "@/lib/factory-diagnosis/worker";
import { drainFactoryJudges } from "@/lib/factory-evaluations/judge-worker";
import { maintainFactoryEvaluationQueue } from "@/lib/factory-evaluations/maintenance";
import { drainFactoryAutomationOccurrences } from "@/lib/factory-automations/admission-service";
import { reconcileFactoryAutomationSchedules } from "@/lib/factory-automations/schedule-service";
import { reconcileFactoryActionsDelivery } from "@/lib/factory-delivery-commands/actions-maintenance";
import { expireFactoryDeliveryDispatches } from "@/lib/factory-delivery-commands/maintenance";
import { drainFactoryMonitoringIncidents } from "@/lib/factory-monitoring/maintenance";
import { processFactoryFailureCohorts } from "@/lib/factory-failures/maintenance";
import {
  reconcileBenchmarkEvaluations,
  reconcileBenchmarkSchedules,
} from "@/lib/factory-benchmarks/schedule-maintenance";
import {
  processFactoryFlowProjection,
  pruneFactoryAnalyticsExports,
} from "@/lib/factory-outcomes/maintenance";
import { processFactoryScorerSampling } from "@/lib/factory-scorers/sampling-maintenance";
import { processFactoryRoutingCanaryAlerts } from "@/lib/model-routing/canary-alert-maintenance";
import { drainFactoryEventDeliveries } from "@/lib/factory-event-subscriptions/dispatch";
import { pruneFactoryEventOutbox } from "@/lib/factory-event-subscriptions/maintenance";
import {
  createBrowserScreenshotRuntime,
  createBrowserVideoRuntime,
} from "@/lib/validation-evidence/browser-runtime";
import { resumePendingWorkspaceDeletions } from "@/lib/workspaces/deletion";
import { drainGitHubConnectorCommentRetries } from "@/features/github/connector-conversation";
import { createGitHubConnectorOutboundAdapter } from "@/features/github/connector-outbound";
import { drainConnectorOutboundDeliveries } from "@/lib/connectors/outbound";
import { drainSlackConnectorEvents } from "@/lib/connectors/slack/intake";
import { drainSlackReviewActionBatch } from "@/lib/connectors/slack/review-actions";
import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";

import { parseWorkerConfig } from "./config";
import { startWorkerControlServer } from "./control";
import { deregisterWorker, registerWorker, sendHeartbeat } from "./heartbeat";
import { createWorkerLifecycle } from "./lifecycle";
import { reconcileLinearIssueDiscovery } from "@/lib/connectors/linear-discovery";
import { reconcileLinearLinkedOutcomes } from "@/lib/connectors/linear-outcomes";
import { reconcileLinearState } from "./reconciler";
import { reapOrphanSandboxes } from "./sandbox-reaper";
import { createScheduler } from "./scheduler";
import { createSlackInboxMaintenance } from "./slack-inbox";
import { createTimerTaskTracker, finishWorkerShutdown } from "./shutdown";
import { sweepStalledRuns } from "./stall-detector";

async function main() {
  const config = parseWorkerConfig();
  const admin = createSupabaseAdminClient();

  console.log("[worker] starting", {
    defaultConcurrencyLimit: config.defaultConcurrencyLimit,
    defaultStallTimeoutMs: config.defaultStallTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    maxConcurrentJobs: config.maxConcurrentJobs,
    pollIntervalMs: config.pollIntervalMs,
    reconcileIntervalMs: config.reconcileIntervalMs,
    sandboxReapIntervalMs: config.sandboxReapIntervalMs,
    stallSweepIntervalMs: config.stallSweepIntervalMs,
    workerId: config.workerId,
  });

  // Register this worker instance.
  await registerWorker(admin, config.workerId);

  let draining = false;

  // Bounded-concurrency scheduler: claims and runs up to maxConcurrentJobs at
  // once. It owns the in-flight set; the heartbeat timer reads it.
  const scheduler = createScheduler(admin, config, {
    isShuttingDown: () => draining,
    browserRuntime: createBrowserScreenshotRuntime() ?? undefined,
    browserVideoRuntime: createBrowserVideoRuntime() ?? undefined,
  });
  const timerTasks = createTimerTaskTracker();
  const heartbeatTasks = createTimerTaskTracker();
  const maintenanceTimers: Array<ReturnType<typeof setInterval>> = [];
  let cursorAuthProcessor: ReturnType<typeof startCursorAuthProcessor> | undefined;
  let schedulerRun = Promise.resolve();
  const lifecycle = createWorkerLifecycle({
    stopClaiming: () => {
      draining = true;
      console.log("[worker] draining active work", { activeJobIds: scheduler.getActiveJobIds() });
    },
    stopMaintenance: () => maintenanceTimers.forEach(clearInterval),
    stopAuxiliaryWork: async () => {
      await cursorAuthProcessor?.stop();
    },
    waitForJobs: async () => {
      // An RPC already in flight can still return an owned job after drain.
      await schedulerRun;
      await scheduler.waitForIdle();
    },
    waitForMaintenance: () => timerTasks.waitForIdle(),
  });

  function shutdown(signal: string) {
    console.log(`[worker] received ${signal}, draining active jobs…`, {
      activeJobIds: scheduler.getActiveJobIds(),
    });
    lifecycle.requestStop();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Finish fallible control setup before starting any work. A drain arriving
  // during startup also prevents the intake loops below from starting.
  const control = config.controlSocketPath
    ? await startWorkerControlServer(config.controlSocketPath, {
        getStatus: () => ({
          workerId: config.workerId,
          phase: lifecycle.getPhase(),
          activeJobIds: scheduler.getActiveJobIds(),
        }),
        requestDrain: lifecycle.requestDrain,
      })
    : undefined;

  // --- Heartbeat interval ---
  const heartbeatTimer = setInterval(() => {
    heartbeatTasks.run("heartbeat", () =>
      sendHeartbeat(admin, config.workerId, scheduler.getActiveJobIds()),
    );
  }, config.heartbeatIntervalMs);

  if (!draining) {
    cursorAuthProcessor = startCursorAuthProcessor(admin, config.workerId);

    let exporting = false;
    let cleaningExports = false;
    maintenanceTimers.push(
      setInterval(() => {
        if (!exporting) {
          exporting = true;
          timerTasks.run("run exports", async () => {
            try {
              await drainRunExports(admin);
            } finally {
              exporting = false;
            }
          });
        }
        if (!cleaningExports) {
          cleaningExports = true;
          timerTasks.run("run export cleanup", async () => {
            try {
              await cleanupRunExports(admin);
            } finally {
              cleaningExports = false;
            }
          });
        }
      }, config.reconcileIntervalMs),
    );

    // --- Stall detection interval ---
    maintenanceTimers.push(
      setInterval(() => {
        timerTasks.run("stall sweep", async () => {
          await drainCheckpointPublications(admin);
          const result = await sweepStalledRuns(admin, config.defaultStallTimeoutMs);
          if (result.stalledRunIds.length > 0) {
            console.log("[worker] stall sweep results", {
              stalledJobIds: result.stalledJobIds,
              stalledRunIds: result.stalledRunIds,
            });
          }
        });
      }, config.stallSweepIntervalMs),
    );

    // --- Reconciliation interval ---
    const drainSlackInbox = createSlackInboxMaintenance({
      drainBatch: () => drainSlackConnectorEvents(admin, { isShuttingDown: () => draining }),
      isShuttingDown: () => draining,
      timerTasks,
    });
    const drainSlackReviews = createSlackInboxMaintenance({
      label: "Slack review actions",
      drainBatch: async () =>
        (await drainSlackReviewActionBatch(admin, { isShuttingDown: () => draining })).hasMore,
      isShuttingDown: () => draining,
      timerTasks,
    });
    maintenanceTimers.push(
      setInterval(() => {
        timerTasks.run("accepted triage route", () => drainAcceptedTriageRoute(admin));
        timerTasks.run("authored workflow entry", () => drainAuthoredFactoryWorkflowEntry(admin));
        timerTasks.run("workflow branches", () => drainFactoryWorkflowBranches(admin));
        timerTasks.run("workflow repository delivery", () =>
          drainFactoryWorkflowRepositoryDeliveries(admin),
        );
        timerTasks.run("exact workflow review", () => drainExactFactoryWorkflowReview(admin));
        timerTasks.run("exact workflow review repair", () =>
          drainExactFactoryWorkflowReviewRepair(admin),
        );
        timerTasks.run("expired workflow review", () => expireExactFactoryWorkflowReview(admin));
        timerTasks.run("GitHub deferred comments", () => drainGitHubConnectorCommentRetries(admin));
        drainSlackInbox();
        drainSlackReviews();
        timerTasks.run("GitHub connector outbound", async () => {
          await drainConnectorOutboundDeliveries(
            admin,
            createGitHubConnectorOutboundAdapter(admin),
          );
        });
        timerTasks.run("Linear issue discovery", async () => {
          await reconcileLinearIssueDiscovery(admin);
        });
        timerTasks.run("Linear linked outcomes", async () => {
          await reconcileLinearLinkedOutcomes(admin);
        });
        timerTasks.run("reconciliation", async () => {
          await drainCheckpointPublications(admin);
          await drainCanonicalPullRequests(admin);
          await reconcileGitHubPrVerification(admin);
          // Best-effort readiness drain: a failed evaluation leaves the prior
          // decision, and the approval gate still fails closed without one.
          await reconcilePrReadiness(admin);
          await drainSourceDeliveries(admin);
          await drainCheckpointCleanup(admin);
          await drainFactoryWorkflowSandboxStops(admin);
          const [result, attachmentCleanup, workspaceDeletion] = await Promise.all([
            reconcileLinearState(admin),
            cleanupExpiredSessionAttachments(admin),
            resumePendingWorkspaceDeletions(admin),
          ]);
          if (
            result.canceled > 0 ||
            result.rateLimited ||
            attachmentCleanup.deleted > 0 ||
            attachmentCleanup.failed > 0 ||
            workspaceDeletion.deleted > 0
          ) {
            console.log("[worker] reconciliation results", {
              attachmentCleanup,
              workspaceDeletion,
              canceled: result.canceled,
              checked: result.checked,
              rateLimited: result.rateLimited,
            });
          }
        });
      }, config.reconcileIntervalMs),
    );

    let deliveringFactoryEvents = false;
    let projectingFactoryFlow = false;
    let samplingFactoryScorers = false;
    let maintainingEvaluationQueue = false;
    let processingFailureCohorts = false;
    let evaluatingFactoryJudges = false;
    let runningFactoryDiagnosis = false;
    let checkingRoutingCanaries = false;
    let reconcilingBenchmarkSchedules = false;
    let reconcilingBenchmarkEvaluations = false;
    let admittingFactoryAutomationOccurrences = false;
    let admittingFactoryMonitoringIncidents = false;
    let reconcilingFactoryAutomationSchedules = false;
    let reconcilingFactoryActionsDelivery = false;
    let expiringFactoryDeliveryDispatches = false;
    maintenanceTimers.push(
      setInterval(() => {
        if (!deliveringFactoryEvents) {
          deliveringFactoryEvents = true;
          timerTasks.run("factory event delivery", async () => {
            try {
              await drainFactoryEventDeliveries(admin);
            } finally {
              deliveringFactoryEvents = false;
            }
          });
        }
        if (!projectingFactoryFlow) {
          projectingFactoryFlow = true;
          timerTasks.run("factory flow projection", async () => {
            try {
              await processFactoryFlowProjection(admin);
            } finally {
              projectingFactoryFlow = false;
            }
          });
        }
        if (!samplingFactoryScorers) {
          samplingFactoryScorers = true;
          timerTasks.run("factory scorer sampling", async () => {
            try {
              await processFactoryScorerSampling(admin);
            } finally {
              samplingFactoryScorers = false;
            }
          });
        }
        if (!maintainingEvaluationQueue) {
          maintainingEvaluationQueue = true;
          timerTasks.run("factory evaluation queue", async () => {
            try {
              await maintainFactoryEvaluationQueue(admin);
            } finally {
              maintainingEvaluationQueue = false;
            }
          });
        }
        if (!processingFailureCohorts) {
          processingFailureCohorts = true;
          timerTasks.run("factory failure cohorts", async () => {
            try {
              await processFactoryFailureCohorts(admin);
            } finally {
              processingFailureCohorts = false;
            }
          });
        }
        if (!evaluatingFactoryJudges) {
          evaluatingFactoryJudges = true;
          timerTasks.run("factory judges", async () => {
            try {
              await drainFactoryJudges(admin, "node");
            } finally {
              evaluatingFactoryJudges = false;
            }
          });
        }
        if (!runningFactoryDiagnosis) {
          runningFactoryDiagnosis = true;
          timerTasks.run("factory diagnosis", async () => {
            try {
              await drainFactoryDiagnoses(admin, "node");
            } finally {
              runningFactoryDiagnosis = false;
            }
          });
        }
        if (!checkingRoutingCanaries) {
          checkingRoutingCanaries = true;
          timerTasks.run("routing canary alerts", async () => {
            try {
              await processFactoryRoutingCanaryAlerts(admin);
            } finally {
              checkingRoutingCanaries = false;
            }
          });
        }
        if (!reconcilingBenchmarkSchedules) {
          reconcilingBenchmarkSchedules = true;
          timerTasks.run("benchmark schedules", async () => {
            try {
              await reconcileBenchmarkSchedules(admin);
            } finally {
              reconcilingBenchmarkSchedules = false;
            }
          });
        }
        if (!reconcilingBenchmarkEvaluations) {
          reconcilingBenchmarkEvaluations = true;
          timerTasks.run("benchmark evaluations", async () => {
            try {
              await reconcileBenchmarkEvaluations(admin);
            } finally {
              reconcilingBenchmarkEvaluations = false;
            }
          });
        }
        if (!reconcilingFactoryAutomationSchedules) {
          reconcilingFactoryAutomationSchedules = true;
          timerTasks.run("factory automation schedules", async () => {
            try {
              await reconcileFactoryAutomationSchedules(admin);
            } finally {
              reconcilingFactoryAutomationSchedules = false;
            }
          });
        }
        if (!expiringFactoryDeliveryDispatches) {
          expiringFactoryDeliveryDispatches = true;
          timerTasks.run("factory delivery dispatch expiry", async () => {
            try {
              await expireFactoryDeliveryDispatches(admin);
            } finally {
              expiringFactoryDeliveryDispatches = false;
            }
          });
        }
        if (!reconcilingFactoryActionsDelivery) {
          reconcilingFactoryActionsDelivery = true;
          timerTasks.run("GitHub Actions delivery", async () => {
            try {
              const result = await reconcileFactoryActionsDelivery(admin);
              if (result.failed > 0) console.warn("[worker] GitHub Actions delivery", result);
            } finally {
              reconcilingFactoryActionsDelivery = false;
            }
          });
        }
        if (!admittingFactoryAutomationOccurrences) {
          admittingFactoryAutomationOccurrences = true;
          timerTasks.run("factory automation occurrences", async () => {
            try {
              await drainFactoryAutomationOccurrences(admin);
            } finally {
              admittingFactoryAutomationOccurrences = false;
            }
          });
        }
        if (!admittingFactoryMonitoringIncidents) {
          admittingFactoryMonitoringIncidents = true;
          timerTasks.run("factory monitoring incidents", async () => {
            try {
              await drainFactoryMonitoringIncidents(admin);
            } finally {
              admittingFactoryMonitoringIncidents = false;
            }
          });
        }
        timerTasks.run("factory event outbox cleanup", () => pruneFactoryEventOutbox(admin));
        timerTasks.run("analytics export cleanup", async () => {
          await pruneFactoryAnalyticsExports(admin);
        });
        timerTasks.run("run retention", async () => {
          const result = await drainRunRetention(admin);
          if (Object.values(result).some((count) => count > 0)) {
            console.log("[worker] run retention results", result);
          }
        });
        timerTasks.run("OAuth credential cleanup", async () => {
          const result = await pruneFactoryOAuthCredentials(admin);
          if (result.authorizationsDeleted > 0 || result.tokenPairsDeleted > 0) {
            console.log("[worker] OAuth credential cleanup results", result);
          }
        });
        timerTasks.run("factory command cleanup", async () => {
          const result = await pruneFactoryCommandAdmissions(admin);
          if (result.admissionsDeleted > 0 || result.leasesDeleted > 0) {
            console.log("[worker] factory command cleanup results", result);
          }
        });
      }, config.reconcileIntervalMs),
    );

    // --- Sandbox reaper interval ---
    // Recovers provider sandboxes whose owning agent_run row is missing or
    // already terminal — the case where a worker crashed mid-stage before the
    // processor's `finally` could call sandbox.stop(). Independent of the
    // stall sweep so we still catch sandboxes whose linked run never made it
    // into the DB.
    maintenanceTimers.push(
      setInterval(() => {
        timerTasks.run("sandbox reap", async () => {
          const result = await reapOrphanSandboxes(admin);
          if (result.reapedSandboxIds.length > 0) {
            console.log("[worker] sandbox reap results", {
              activeProviderCount: result.activeProviderCount,
              reapedSandboxIds: result.reapedSandboxIds,
            });
          }
        });
      }, config.sandboxReapIntervalMs),
    );
  }

  // --- Main scheduling loop ---
  console.log("[worker] entering scheduler loop");
  schedulerRun = scheduler.run();

  // Drained workers keep the control socket and heartbeat alive until SIGTERM.
  await lifecycle.waitForStop();
  await finishWorkerShutdown({
    deregister: () => deregisterWorker(admin, config.workerId),
    scheduler,
    stopTimers: () => {
      clearInterval(heartbeatTimer);
    },
    timerTasks: heartbeatTasks,
  });
  await control?.close();
  console.log("[worker] graceful shutdown complete", { workerId: config.workerId });
}

// Process-level crash handlers (uncaughtException / unhandledRejection) are
// installed by ./scripts/install-crash-handlers.mjs, preloaded via `node
// --import` so they cover import-time failures in this module's graph too.

// Run the worker.
main().catch((error) => {
  console.error("[worker] fatal error", { error: error instanceof Error ? error.message : error });
  process.exit(1);
});
