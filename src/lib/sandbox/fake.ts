import type {
  RunningSandboxSummary,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
} from "./types";

// In-memory registry shared by FakeSandbox + the listing/stop helpers, so
// tests can simulate "the provider knows about these sandboxes" without
// holding a SandboxHandle reference.
interface FakeRegistryEntry {
  id: string;
  status: "pending" | "running" | "stopped";
  createdAt: number;
}

const fakeRegistry = new Map<string, FakeRegistryEntry>();

/** Register a fake sandbox as if the provider had created it. Test-only. */
export function registerFakeSandbox(
  id: string,
  opts: { status?: "pending" | "running"; createdAt?: number } = {},
): void {
  fakeRegistry.set(id, {
    id,
    status: opts.status ?? "running",
    createdAt: opts.createdAt ?? Date.now(),
  });
}

/** Reset the in-memory fake registry. Test-only. */
export function resetFakeSandboxes(): void {
  fakeRegistry.clear();
}

/** Mirrors stopVercelSandboxById; flips the registry entry to `stopped`. */
export async function stopFakeSandboxById(sandboxId: string): Promise<void> {
  const entry = fakeRegistry.get(sandboxId);
  if (entry) entry.status = "stopped";
}

/** Mirrors listRunningVercelSandboxes; returns active entries. */
export async function listRunningFakeSandboxes(): Promise<RunningSandboxSummary[]> {
  const result: RunningSandboxSummary[] = [];
  for (const e of fakeRegistry.values()) {
    if (e.status === "pending" || e.status === "running") {
      result.push({ id: e.id, status: e.status, createdAt: e.createdAt });
    }
  }
  return result;
}

/**
 * In-memory FakeSandbox for unit tests. Lets tests script the output of each
 * `exec(cmd, args, opts)` call with `scriptExec(matcher, logs, exitCode?)`.
 * Writes/reads go to an in-memory Map.
 */

export interface FakeExecCall {
  cmd: string;
  args: string[];
  opts: SandboxExecOptions;
}

type LogProducer = SandboxLogEntry[] | ((call: FakeExecCall) => SandboxLogEntry[]);

interface ExecScript {
  matches: (call: FakeExecCall) => boolean;
  logs: LogProducer;
  exitCode: number;
}

let fakeSandboxCounter = 0;

export class FakeSandbox implements SandboxHandle {
  readonly id: string;
  readonly repoPath = "/vercel/sandbox";

  readonly calls: FakeExecCall[] = [];
  readonly files = new Map<string, { data: Buffer; mode?: number }>();

  private scripts: ExecScript[] = [];
  private stopped = false;

  constructor(id?: string) {
    this.id = id ?? `fake-sandbox-${++fakeSandboxCounter}`;
    fakeRegistry.set(this.id, {
      id: this.id,
      status: "running",
      createdAt: Date.now(),
    });
  }

  /** Queue the next matching exec to produce `logs` and exit with `exitCode`. */
  scriptExec(
    matcher: string | ((call: FakeExecCall) => boolean),
    logs: LogProducer,
    opts: { exitCode?: number } = {},
  ): void {
    const matches =
      typeof matcher === "function"
        ? matcher
        : (call: FakeExecCall) => call.cmd === matcher || call.args.includes(matcher);
    this.scripts.push({ matches, logs, exitCode: opts.exitCode ?? 0 });
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    if (this.stopped) throw new Error("FakeSandbox: sandbox is stopped");

    const call: FakeExecCall = { cmd, args, opts };
    this.calls.push(call);

    const idx = this.scripts.findIndex((s) => s.matches(call));
    const script =
      idx >= 0
        ? this.scripts.splice(idx, 1)[0]
        : { logs: [] as SandboxLogEntry[], exitCode: 0, matches: () => true };

    const entries = typeof script.logs === "function" ? script.logs(call) : script.logs;

    const logsIter = async function* (): AsyncIterable<SandboxLogEntry> {
      for (const e of entries) yield e;
    };

    return {
      logs: logsIter,
      output: async () => {
        let stdout = "";
        let stderr = "";
        for (const entry of entries) {
          if (entry.stream === "stdout") stdout += entry.data;
          else stderr += entry.data;
        }
        return { stdout, stderr };
      },
      exitCode: Promise.resolve(script.exitCode),
      kill: async () => {
        /* no-op */
      },
    };
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    opts: { mode?: number } = {},
  ): Promise<void> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.files.set(path, { data: buf, mode: opts.mode });
  }

  async readFile(path: string): Promise<string | null> {
    const entry = this.files.get(path);
    return entry ? entry.data.toString("utf8") : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const entry = fakeRegistry.get(this.id);
    if (entry) entry.status = "stopped";
  }
}
