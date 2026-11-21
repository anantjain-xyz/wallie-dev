export class WorkerAttemptDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAttemptDeadlineError";
  }
}

export function createWorkerAttemptDeadline(timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new WorkerAttemptDeadlineError(message)),
    timeoutMs,
  );
  return { signal: controller.signal, [Symbol.dispose]: () => clearTimeout(timer) };
}
