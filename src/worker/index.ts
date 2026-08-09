import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";

import { parseWorkerConfig } from "./config";
import { deregisterWorker, registerWorker, sendHeartbeat } from "./heartbeat";
import { reconcileLinearState } from "./reconciler";
import { reapOrphanSandboxes } from "./sandbox-reaper";
import { createScheduler } from "./scheduler";
import { finishWorkerShutdown } from "./shutdown";
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

  let shuttingDown = false;

  // Bounded-concurrency scheduler: claims and runs up to maxConcurrentJobs at
  // once. It owns the in-flight set; the heartbeat timer reads it.
  const scheduler = createScheduler(admin, config, {
    isShuttingDown: () => shuttingDown,
  });

  // Stop claiming on a graceful signal. The main flow below keeps heartbeats
  // active while already-claimed jobs drain, then deregisters and exits.
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, draining active jobs…`, {
      activeJobIds: scheduler.getActiveJobIds(),
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // --- Heartbeat interval ---
  const heartbeatTimer = setInterval(() => {
    runTimerTask("heartbeat", () =>
      sendHeartbeat(admin, config.workerId, scheduler.getActiveJobIds()),
    );
  }, config.heartbeatIntervalMs);

  // --- Stall detection interval ---
  const stallTimer = setInterval(() => {
    runTimerTask("stall sweep", async () => {
      const result = await sweepStalledRuns(admin, config.defaultStallTimeoutMs);
      if (result.stalledRunIds.length > 0) {
        console.log("[worker] stall sweep results", {
          stalledJobIds: result.stalledJobIds,
          stalledRunIds: result.stalledRunIds,
        });
      }
    });
  }, config.stallSweepIntervalMs);

  // --- Reconciliation interval ---
  const reconcileTimer = setInterval(() => {
    runTimerTask("reconciliation", async () => {
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
  }, config.reconcileIntervalMs);

  // --- Sandbox reaper interval ---
  // Recovers provider sandboxes whose owning agent_run row is missing or
  // already terminal — the case where a worker crashed mid-stage before the
  // processor's `finally` could call sandbox.stop(). Independent of the
  // stall sweep so we still catch sandboxes whose linked run never made it
  // into the DB.
  const sandboxReapTimer = setInterval(() => {
    runTimerTask("sandbox reap", async () => {
      const result = await reapOrphanSandboxes(admin);
      if (result.reapedSandboxIds.length > 0) {
        console.log("[worker] sandbox reap results", {
          activeProviderCount: result.activeProviderCount,
          reapedSandboxIds: result.reapedSandboxIds,
        });
      }
    });
  }, config.sandboxReapIntervalMs);

  // --- Main scheduling loop ---
  console.log("[worker] entering scheduler loop");
  await scheduler.run();

  await finishWorkerShutdown({
    deregister: () => deregisterWorker(admin, config.workerId),
    scheduler,
    stopTimers: () => {
      clearInterval(heartbeatTimer);
      clearInterval(stallTimer);
      clearInterval(reconcileTimer);
      clearInterval(sandboxReapTimer);
    },
  });
  console.log("[worker] graceful shutdown complete", { workerId: config.workerId });
}

function runTimerTask(label: string, task: () => Promise<void>): void {
  void task().catch((error) => {
    console.error(`[worker] ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Process-level crash handlers (uncaughtException / unhandledRejection) are
// installed by ./scripts/install-crash-handlers.mjs, preloaded via `node
// --import` so they cover import-time failures in this module's graph too.

// Run the worker.
main().catch((error) => {
  console.error("[worker] fatal error", { error: error instanceof Error ? error.message : error });
  process.exit(1);
});
