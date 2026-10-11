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
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      try {
        await input.handle.stop();
      } catch (cleanupError) {
        console.error("[sandbox] acquisition failure cleanup failed", {
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          provider: input.provider,
          sandboxId: input.handle.id,
        });
      }
    })());
  const onAbort = () => {
    void stop();
  };
  input.request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    input.request.signal?.throwIfAborted();
    await input.request.onSandboxCreated?.({
      provider: input.provider,
      sandboxId: input.handle.id,
    });
    input.request.signal?.throwIfAborted();
    await prepareSessionSandbox({
      handle: input.handle,
      provider: input.provider,
      repoAlreadyCloned: input.repoAlreadyCloned,
      request: input.request,
    });
    input.request.signal?.throwIfAborted();
    return input.handle;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    input.request.signal?.removeEventListener("abort", onAbort);
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
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const operation = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return input.run(signal);
  });
  void operation.then(
    (value) => {
      if (!abandoned || !input.onLateSuccess) return;
      void Promise.resolve()
        .then(() => input.onLateSuccess!(value))
        .catch((error) => {
          console.error("[sandbox] late provider operation cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
            operation: input.operation,
            provider: input.provider,
          });
        });
    },
    () => undefined,
  );

  let onAbort: () => void;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      abandoned = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    timer = setTimeout(() => {
      controller.abort(deadlineError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort!);
  }
}
