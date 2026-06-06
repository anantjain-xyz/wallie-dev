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
  let activeJobId: string | null = null;

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
    runTimerTask("heartbeat", () => sendHeartbeat(admin, config.workerId, activeJobId));
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
      const result = await reconcileLinearState(admin);
      if (result.canceled > 0 || result.rateLimited) {
        console.log("[worker] reconciliation results", {
          canceled: result.canceled,
          checked: result.checked,
          rateLimited: result.rateLimited,
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

  // --- Main polling loop ---
  console.log("[worker] entering poll loop");
  while (!shuttingDown) {
    try {
      const result = await pollOnce(admin, config, {
        setActiveJobId: (jobId) => {
          activeJobId = jobId;
        },
      });

      if (result.outcome === "idle") {
        // Nothing to do — sleep for the full poll interval.
        await delay(config.pollIntervalMs);
      } else if (result.outcome === "error") {
        // Back off slightly on errors to avoid tight retry loops.
        await delay(config.pollIntervalMs * 2);
      }
      // On "success", loop immediately to check for more work.
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

function runTimerTask(label: string, task: () => Promise<void>): void {
  void task().catch((error) => {
    console.error(`[worker] ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Surface otherwise-silent process-level failures. Without these, an uncaught
 * exception or unhandled promise rejection escaping the poll loop kills the
 * process with no `[worker]` log line — leaving only pnpm's generic
 * `ELIFECYCLE Command failed`. We log the full stack, then exit so the platform
 * can restart us cleanly (process state is undefined after these events, so
 * continuing is unsafe).
 */
function installCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    // Pass the raw error as the second arg so the full stack renders natively.
    console.error("[worker] uncaught exception — exiting", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandled rejection — exiting", reason);
    process.exit(1);
  });
}

installCrashHandlers();

// Run the worker.
main().catch((error) => {
  console.error("[worker] fatal error", { error: error instanceof Error ? error.message : error });
  process.exit(1);
});
