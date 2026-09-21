import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { startCursorAuthProcessor } from "@/lib/cursor/auth-processor";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";

import { parseWorkerConfig } from "./config";
import { startWorkerControlServer } from "./control";
import { deregisterWorker, registerWorker, sendHeartbeat } from "./heartbeat";
import { createWorkerLifecycle } from "./lifecycle";
import { reconcileLinearState } from "./reconciler";
import { reapOrphanSandboxes } from "./sandbox-reaper";
import { createScheduler } from "./scheduler";
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

    // --- Stall detection interval ---
    maintenanceTimers.push(
      setInterval(() => {
        timerTasks.run("stall sweep", async () => {
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
    maintenanceTimers.push(
      setInterval(() => {
        timerTasks.run("reconciliation", async () => {
          const [result, attachmentCleanup] = await Promise.all([
            reconcileLinearState(admin),
            cleanupExpiredSessionAttachments(admin),
          ]);
          if (
            result.canceled > 0 ||
            result.rateLimited ||
            attachmentCleanup.deleted > 0 ||
            attachmentCleanup.failed > 0
          ) {
            console.log("[worker] reconciliation results", {
              attachmentCleanup,
              canceled: result.canceled,
              checked: result.checked,
              rateLimited: result.rateLimited,
            });
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
