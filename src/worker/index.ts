import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { parseWorkerConfig } from "./config";
import { deregisterWorker, registerWorker, sendHeartbeat } from "./heartbeat";
import { pollOnce } from "./loop";
import { reconcileLinearState } from "./reconciler";
import { reapOrphanSandboxes } from "./sandbox-reaper";
import { sweepStalledRuns } from "./stall-detector";

async function main() {
  const config = parseWorkerConfig();
  const admin = createSupabaseAdminClient();

  console.log("[worker] starting", {
    defaultConcurrencyLimit: config.defaultConcurrencyLimit,
    defaultStallTimeoutMs: config.defaultStallTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    reconcileIntervalMs: config.reconcileIntervalMs,
    sandboxReapIntervalMs: config.sandboxReapIntervalMs,
    stallSweepIntervalMs: config.stallSweepIntervalMs,
    workerId: config.workerId,
  });

  // Register this worker instance.
  await registerWorker(admin, config.workerId);

  let shuttingDown = false;

  // Graceful shutdown handler.
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down…`);
    await deregisterWorker(admin, config.workerId);
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // --- Heartbeat interval ---
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat(admin, config.workerId, null);
  }, config.heartbeatIntervalMs);

  // --- Stall detection interval ---
  const stallTimer = setInterval(() => {
    void sweepStalledRuns(admin, config.defaultStallTimeoutMs).then((result) => {
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
    void reconcileLinearState(admin).then((result) => {
      if (result.canceled > 0) {
        console.log("[worker] reconciliation results", {
          canceled: result.canceled,
          checked: result.checked,
        });
      }
    });
  }, config.reconcileIntervalMs);

  // --- Sandbox reaper interval ---
  // Recovers Vercel sandboxes whose owning agent_run row is missing or
  // already terminal — the case where a worker crashed mid-stage before the
  // processor's `finally` could call sandbox.stop(). Independent of the
  // stall sweep so we still catch sandboxes whose linked run never made it
  // into the DB.
  const sandboxReapTimer = setInterval(() => {
    void reapOrphanSandboxes(admin).then((result) => {
      if (result.reapedSandboxIds.length > 0) {
        console.log("[worker] sandbox reap results", {
          activeProviderCount: result.activeProviderCount,
          reapedSandboxIds: result.reapedSandboxIds,
        });
      }
    });
  }, config.sandboxReapIntervalMs);

  // --- Main polling loop ---
  console.log("[worker] entering poll loop");
  while (!shuttingDown) {
    try {
      const result = await pollOnce(admin, config);

      if (result.outcome === "idle" || result.outcome === "concurrency_limited") {
        // Nothing to do — sleep for the full poll interval.
        await delay(config.pollIntervalMs);
      } else if (result.outcome === "error") {
        // Back off slightly on errors to avoid tight retry loops.
        await delay(config.pollIntervalMs * 2);
      }
      // On "success" or "claimed", loop immediately to check for more work.
    } catch (error) {
      console.error("[worker] poll loop error", {
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(config.pollIntervalMs * 2);
    }
  }

  // Cleanup (unreachable in normal flow — shutdown handler exits).
  clearInterval(heartbeatTimer);
  clearInterval(stallTimer);
  clearInterval(reconcileTimer);
  clearInterval(sandboxReapTimer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the worker.
main().catch((error) => {
  console.error("[worker] fatal error", { error: error instanceof Error ? error.message : error });
  process.exit(1);
});
