import { prepareSessionSandbox } from "./setup";
import {
  getSandboxProviderContract,
  providerLabel,
  type SandboxProviderOperation,
} from "./provider-contract";
import type { CreateSessionSandboxInput, SandboxHandle, SandboxProvider } from "./types";

export async function finalizeSandboxAcquisition(input: {
  handle: SandboxHandle;
  provider: SandboxProvider;
  repoAlreadyCloned: boolean;
  request: CreateSessionSandboxInput;
}): Promise<SandboxHandle> {
  try {
    await input.request.onSandboxCreated?.({
      provider: input.provider,
      sandboxId: input.handle.id,
    });
    await prepareSessionSandbox({
      handle: input.handle,
      provider: input.provider,
      repoAlreadyCloned: input.repoAlreadyCloned,
      request: input.request,
    });
    return input.handle;
  } catch (error) {
    try {
      await input.handle.stop();
    } catch (cleanupError) {
      console.error("[sandbox] acquisition failure cleanup failed", {
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        provider: input.provider,
        sandboxId: input.handle.id,
      });
    }
    throw error;
  }
}

export class SandboxProviderDeadlineError extends Error {
  readonly operation: SandboxProviderOperation;
  readonly provider: SandboxProvider;
  readonly timeoutMs: number;

  constructor(provider: SandboxProvider, operation: SandboxProviderOperation, timeoutMs: number) {
    super(
      `${providerLabel(provider)} ${operation} exceeded its ${timeoutMs}ms provider-contract deadline (semantic owner: bounded provider remote operations).`,
    );
    this.name = "SandboxProviderDeadlineError";
    this.operation = operation;
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export async function runBoundedSandboxProviderOperation<T>(input: {
  onLateSuccess?: (value: T) => Promise<void> | void;
  operation: SandboxProviderOperation;
  provider: SandboxProvider;
  run: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutMs =
    input.timeoutMs ?? getSandboxProviderContract(input.provider).deadlines[input.operation];
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const deadlineError = new SandboxProviderDeadlineError(
    input.provider,
    input.operation,
    timeoutMs,
  );
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const operation = Promise.resolve().then(() => input.run(signal));
  void operation.then(
    (value) => {
      if (!timedOut || !input.onLateSuccess) return;
      void Promise.resolve(input.onLateSuccess(value)).catch((error) => {
        console.error("[sandbox] late provider operation cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
          operation: input.operation,
          provider: input.provider,
        });
      });
    },
    () => undefined,
  );

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(deadlineError);
      reject(deadlineError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
