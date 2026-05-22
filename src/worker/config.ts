export type WorkerConfig = {
  /** How often the worker polls for queued jobs (milliseconds). */
  pollIntervalMs: number;
  /** How often the worker sends a heartbeat (milliseconds). */
  heartbeatIntervalMs: number;
  /** How often the stall-detection sweep runs (milliseconds). */
  stallSweepIntervalMs: number;
  /** How often the reconciliation sweep runs (milliseconds). */
  reconcileIntervalMs: number;
  /** How often the sandbox reaper runs (milliseconds). */
  sandboxReapIntervalMs: number;
  /** Default stall timeout if not configured per-workspace (milliseconds). */
  defaultStallTimeoutMs: number;
  /** Default per-workspace concurrency limit if not configured. */
  defaultConcurrencyLimit: number;
  /** Unique identifier for this worker instance. */
  workerId: string;
};

/** Build worker config with baked-in defaults and a generated worker id. */
export function parseWorkerConfig(): WorkerConfig {
  return {
    pollIntervalMs: 2_000,
    heartbeatIntervalMs: 10_000,
    stallSweepIntervalMs: 30_000,
    reconcileIntervalMs: 60_000,
    sandboxReapIntervalMs: 60_000,
    defaultStallTimeoutMs: 900_000, // 15 minutes
    defaultConcurrencyLimit: 2,
    workerId: `worker-${process.pid}-${Date.now()}`,
  };
}
