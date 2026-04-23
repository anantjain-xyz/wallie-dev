import type { CreateSessionSandboxInput, SandboxHandle } from "./types";

export type {
  AgentProvider,
  CreateSessionSandboxInput,
  SandboxCheckoutMode,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
} from "./types";
export { FakeSandbox } from "./fake";

/**
 * Create a per-session sandbox. The real Vercel Sandbox implementation is
 * loaded lazily so test/build paths that set `WALLIE_SANDBOX_IMPL=fake` never
 * pull in `@vercel/sandbox`.
 */
export async function createSessionSandbox(
  input: CreateSessionSandboxInput,
): Promise<SandboxHandle> {
  const impl = process.env.WALLIE_SANDBOX_IMPL ?? "vercel";
  if (impl === "fake") {
    const { FakeSandbox } = await import("./fake");
    return new FakeSandbox();
  }
  if (impl !== "vercel") {
    throw new Error(`Unknown WALLIE_SANDBOX_IMPL: ${impl}. Expected "vercel" or "fake".`);
  }
  const { createVercelSessionSandbox } = await import("./vercel");
  return createVercelSessionSandbox(input);
}
