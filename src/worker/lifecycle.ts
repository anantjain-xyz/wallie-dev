export type WorkerPhase = "running" | "draining" | "drained" | "stopping";

interface WorkerLifecycleInput {
  stopClaiming: () => void;
  stopMaintenance: () => void;
  stopAuxiliaryWork: () => Promise<void>;
  /** Includes the scheduler loop, any pending claim, and all claimed jobs. */
  waitForJobs: () => Promise<void>;
  waitForMaintenance: () => Promise<void>;
}

/** A one-way drain keeps the worker alive until a separate stop request. */
export function createWorkerLifecycle(input: WorkerLifecycleInput) {
  let phase: WorkerPhase = "running";
  let drained = false;
  let stopRequested = false;
  let resolveStopped!: () => void;
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  // A drain can fail before the caller begins awaiting process shutdown.
  void stopped.catch(() => {});

  function requestDrain(): void {
    if (phase !== "running") return;
    phase = "draining";
    input.stopClaiming();
    input.stopMaintenance();
    // Calling stopAuxiliaryWork now closes its intake before returning status.
    void Promise.all([
      input.stopAuxiliaryWork(),
      input.waitForJobs(),
      input.waitForMaintenance(),
    ]).then(() => {
      drained = true;
      if (stopRequested) resolveStopped();
      else phase = "drained";
    }, rejectStopped);
  }

  function requestStop(): void {
    requestDrain();
    stopRequested = true;
    phase = "stopping";
    if (drained) resolveStopped();
  }

  return {
    getPhase: () => phase,
    requestDrain,
    requestStop,
    waitForStop: () => stopped,
  };
}
