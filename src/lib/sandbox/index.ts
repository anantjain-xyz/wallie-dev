import type { CreateSessionSandboxInput, RunningSandboxSummary, SandboxHandle } from "./types";

export type {
  AgentProvider,
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxCheckoutMode,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxImplementation,
  SandboxLogEntry,
} from "./types";
export { FakeSandbox } from "./fake";

function resolveImpl(override?: CreateSessionSandboxInput["implementation"]): "vercel" | "fake" {
  const impl = override ?? process.env.WALLIE_SANDBOX_IMPL ?? "vercel";
  if (impl !== "vercel" && impl !== "fake") {
    throw new Error(`Unknown WALLIE_SANDBOX_IMPL: ${impl}. Expected "vercel" or "fake".`);
  }
  return impl;
}

/**
 * Create a per-session sandbox. The real Vercel Sandbox implementation is
 * loaded lazily so test/build paths that set `WALLIE_SANDBOX_IMPL=fake` never
 * pull in `@vercel/sandbox`.
 */
export async function createSessionSandbox(
  input: CreateSessionSandboxInput,
): Promise<SandboxHandle> {
  if (resolveImpl(input.implementation) === "fake") {
    const { FakeSandbox } = await import("./fake");
    return new FakeSandbox();
  }
  const { createVercelSessionSandbox } = await import("./vercel");
  return createVercelSessionSandbox(input);
}

/**
 * Stop a sandbox by its provider ID. Used by the stall sweep and reaper to
 * terminate orphans. Idempotent and best-effort: errors are logged, not
 * thrown, so a single bad ID does not break a batch sweep.
 */
export async function stopSandboxById(sandboxId: string): Promise<void> {
  if (resolveImpl() === "fake") {
    const { stopFakeSandboxById } = await import("./fake");
    await stopFakeSandboxById(sandboxId);
    return;
  }
  const { stopVercelSandboxById } = await import("./vercel");
  await stopVercelSandboxById(sandboxId);
}

/**
 * List sandboxes that are currently in an active state (`pending` or
 * `running`). The reaper cross-references these against active `agent_runs`
 * rows to find orphans.
 */
export async function listRunningSandboxes(): Promise<RunningSandboxSummary[]> {
  if (resolveImpl() === "fake") {
    const { listRunningFakeSandboxes } = await import("./fake");
    return listRunningFakeSandboxes();
  }
  const { listRunningVercelSandboxes } = await import("./vercel");
  return listRunningVercelSandboxes();
}
