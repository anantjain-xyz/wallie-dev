import { z } from "zod";

const workerConfigSchema = z.object({
  /** How often the worker polls for queued jobs (milliseconds). */
  pollIntervalMs: z.number().int().min(500).default(2_000),
  /** How often the worker sends a heartbeat (milliseconds). */
  heartbeatIntervalMs: z.number().int().min(1_000).default(10_000),
  /** How often the stall-detection sweep runs (milliseconds). */
  stallSweepIntervalMs: z.number().int().min(5_000).default(30_000),
  /** How often the reconciliation sweep runs (milliseconds). */
  reconcileIntervalMs: z.number().int().min(10_000).default(60_000),
  /** Default stall timeout if not configured per-workspace (milliseconds). */
  defaultStallTimeoutMs: z.number().int().min(10_000).default(300_000), // 5 minutes
  /** Default per-workspace concurrency limit if not configured. */
  defaultConcurrencyLimit: z.number().int().min(1).default(2),
  /** Unique identifier for this worker instance. */
  workerId: z.string().min(1),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/**
 * Build worker config from environment variables with sensible defaults.
 */
export function parseWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  return workerConfigSchema.parse({
    pollIntervalMs: intOrUndefined(env.WALLIE_WORKER_POLL_INTERVAL_MS),
    heartbeatIntervalMs: intOrUndefined(env.WALLIE_WORKER_HEARTBEAT_INTERVAL_MS),
    stallSweepIntervalMs: intOrUndefined(env.WALLIE_WORKER_STALL_SWEEP_INTERVAL_MS),
    reconcileIntervalMs: intOrUndefined(env.WALLIE_WORKER_RECONCILE_INTERVAL_MS),
    defaultStallTimeoutMs: intOrUndefined(env.WALLIE_WORKER_DEFAULT_STALL_TIMEOUT_MS),
    defaultConcurrencyLimit: intOrUndefined(env.WALLIE_WORKER_DEFAULT_CONCURRENCY_LIMIT),
    workerId: env.WALLIE_WORKER_ID || `worker-${process.pid}-${Date.now()}`,
  });
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
