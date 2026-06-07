import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

import type { WorkerConfig } from "./config";
import { sendHeartbeat } from "./heartbeat";
import { claimNextJob, runClaimedJob } from "./loop";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

export interface SchedulerOptions {
  /** Returns true once a shutdown has been requested. */
  isShuttingDown: () => boolean;
  /** Sleep helper; injectable for tests. */
  delay?: (ms: number) => Promise<void>;
}

export interface Scheduler {
  /** Drive the claim/run loop until shutdown is requested. */
  run(): Promise<void>;
  /** The jobs this worker is currently processing. */
  getActiveJobIds(): string[];
}

/**
 * Bounded-concurrency job scheduler. A single worker process claims and runs
 * up to `config.maxConcurrentJobs` jobs at once, repeatedly filling its free
 * capacity from the concurrency-aware claim RPC (which still enforces the
 * per-workspace limit). The heartbeat reports the full in-flight set so the
 * stall detector never sweeps a job a live worker is holding.
 */
export function createScheduler(
  admin: AdminClient,
  config: WorkerConfig,
  options: SchedulerOptions,
): Scheduler {
  const inFlight = new Map<string, Promise<void>>();
  const delay = options.delay ?? defaultDelay;

  function getActiveJobIds(): string[] {
    return [...inFlight.keys()];
  }

  async function emitHeartbeat(): Promise<void> {
    await sendHeartbeat(admin, config.workerId, getActiveJobIds());
  }

  function startJob(job: AgentJobRow): void {
    const promise = runClaimedJob(admin, job)
      .catch((error) => {
        // runClaimedJob is designed never to reject; guard anyway so an
        // unhandled rejection can't trip the process crash handlers.
        console.error("[worker] unexpected job failure", {
          error: error instanceof Error ? error.message : String(error),
          jobId: job.id,
        });
      })
      .finally(() => {
        inFlight.delete(job.id);
        // Stop advertising the freed job before the next interval tick.
        void emitHeartbeat();
      });
    inFlight.set(job.id, promise);
  }

  async function run(): Promise<void> {
    while (!options.isShuttingDown()) {
      let hadError = false;

      // Fill phase: claim until we hit the per-process cap or run out of work.
      while (inFlight.size < config.maxConcurrentJobs && !options.isShuttingDown()) {
        const result = await claimNextJob(admin, config);
        if (result.outcome === "error") {
          hadError = true;
          break;
        }
        if (result.outcome === "idle") {
          break;
        }
        startJob(result.job);
        // Advertise the newly-claimed job immediately so a job claimed between
        // heartbeat ticks is protected within the stall detector's window.
        await emitHeartbeat();
      }

      if (options.isShuttingDown()) break;

      // Wait phase: avoid busy-spinning.
      if (hadError) {
        // Back off so a failing RPC doesn't become a tight retry loop.
        await delay(config.pollIntervalMs * 2);
      } else if (inFlight.size > 0) {
        // At capacity, or holding work with nothing new to claim — wake when a
        // slot frees, but re-poll at least every interval to catch new work.
        await Promise.race([...inFlight.values(), delay(config.pollIntervalMs)]);
      } else {
        // Fully idle — nothing in flight and nothing to claim.
        await delay(config.pollIntervalMs);
      }
    }
  }

  return { getActiveJobIds, run };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
