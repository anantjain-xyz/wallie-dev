import { shellQuote } from "@/lib/sandbox/command";
import type { SandboxExecHandle, SandboxExecOptions, SandboxHandle } from "@/lib/sandbox/types";

import { AgentOutputSafety } from "./safety";
import type { AgentEvent, AgentRunnerStartInput } from "./types";

const cleanupTimeoutMs = 5_000;
const loadPrivateEnvironment = [
  "set +x +v",
  "set -e",
  'source "$1"',
  'rm -f -- "$1"',
  "shift",
  'exec "$@"',
].join("\n");

export class ScopedCredentialCleanupError extends Error {
  constructor() {
    super("Could not verify cleanup of the scoped credential in the sandbox.");
    this.name = "ScopedCredentialCleanupError";
  }
}

export function isScopedCredentialCleanupError(error: unknown): boolean {
  // The output sanitizer reconstructs errors and preserves their names.
  return error instanceof Error && error.name === "ScopedCredentialCleanupError";
}

class ScopedRunnerMaterial {
  private readonly files = new Set<string>();
  private readonly writes = new Set<Promise<void>>();
  private command: Promise<SandboxExecHandle> | undefined;
  private exited = false;
  private cleanup: Promise<void> | undefined;

  constructor(
    private readonly sandbox: SandboxHandle,
    private readonly signal?: AbortSignal,
    private readonly onCleanup?: NonNullable<AgentRunnerStartInput["mcp"]>["onCleanup"],
  ) {}

  trackFile(path: string): void {
    this.signal?.throwIfAborted();
    // Register before upload because a provider can report failure after writing.
    this.files.add(path);
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.trackFile(path);
    let upload: Promise<void> | undefined;
    try {
      upload = this.sandbox.writeFile(path, value, { mode: 0o600 });
      this.writes.add(upload);
      await upload;
    } catch {
      throw new Error("Could not stage the scoped credential in the sandbox.");
    } finally {
      if (upload) this.writes.delete(upload);
    }
  }

  async exec(
    cmd: string,
    args: string[],
    options: SandboxExecOptions,
    privateEnvironment?: { path: string; values: Readonly<Record<string, string>> },
  ): Promise<SandboxExecHandle> {
    this.signal?.throwIfAborted();
    if (privateEnvironment) {
      const { path, values } = privateEnvironment;
      await this.writeFile(
        path,
        `${Object.entries(values)
          .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
          .join("\n")}\n`,
      );
      this.signal?.throwIfAborted();
      // Some sandbox APIs implement environment overrides via command text. Only
      // the path travels with this command, and the key file is unlinked before exec.
      this.command = this.sandbox.exec(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          loadPrivateEnvironment,
          "wallie-credential",
          path,
          cmd,
          ...args,
        ],
        options,
      );
    } else {
      this.command = this.sandbox.exec(cmd, args, options);
    }
    const command = await this.command;
    void command.exitCode.then(
      () => {
        this.exited = true;
      },
      () => undefined,
    );
    return command;
  }

  async *guard(events: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
    // A provider's log iterator may not return on cancellation. Cleanup must
    // still run in a retained sandbox, including during upload or launch.
    const onAbort = () => {
      void this.close().catch(() => this.sandbox.stop().catch(() => undefined));
    };
    if (this.signal?.aborted) onAbort();
    else this.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const event of events) {
        if (event.type === "completion" && event.taskComplete) await this.close();
        yield event;
      }
    } finally {
      this.signal?.removeEventListener("abort", onAbort);
      await this.close();
    }
  }

  private close(): Promise<void> {
    this.cleanup ??= this.remove().then(
      () => this.reportCleanup("removed"),
      async (error: unknown) => {
        await this.reportCleanup("failed");
        throw error;
      },
    );
    return this.cleanup;
  }

  private async reportCleanup(status: "removed" | "failed"): Promise<void> {
    try {
      await this.onCleanup?.(status);
    } catch {
      // Receipt delivery cannot hide or change the cleanup result.
    }
  }

  private async remove(): Promise<void> {
    if (!this.files.size) return;
    await verifyScopedCredentialCleanup(async (signal) => {
      await Promise.allSettled(this.writes);
      try {
        const command = await this.command;
        if (command && !this.exited) {
          await command.kill("SIGKILL");
          await command.exitCode.catch(() => undefined);
        }
      } finally {
        const removal = await this.sandbox.exec("rm", ["-f", "--", ...this.files], {
          cwd: "/tmp",
          signal,
        });
        if ((await removal.exitCode) !== 0) throw new ScopedCredentialCleanupError();
      }
    });
  }
}

export function withRunnerCredentials(
  input: AgentRunnerStartInput,
  run: (safety: AgentOutputSafety, material?: ScopedRunnerMaterial) => AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  const safety = new AgentOutputSafety(input.secrets, input.onSensitiveValue);
  const material =
    input.scopedCredential && input.sandbox
      ? new ScopedRunnerMaterial(input.sandbox, input.signal, input.mcp?.onCleanup)
      : undefined;
  const events = run(safety, material);
  return safety.events(material ? material.guard(events) : events, input.signal);
}

export type { ScopedRunnerMaterial };

export async function verifyScopedCredentialCleanup(
  operation: (signal: AbortSignal) => Promise<void>,
) {
  const signal = AbortSignal.timeout(cleanupTimeoutMs);
  let abort: () => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new ScopedCredentialCleanupError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([operation(signal), deadline]);
  } catch {
    throw new ScopedCredentialCleanupError();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
