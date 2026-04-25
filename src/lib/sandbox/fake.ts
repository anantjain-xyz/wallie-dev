import type {
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
} from "./types";

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

export class FakeSandbox implements SandboxHandle {
  readonly id = "fake-sandbox";
  readonly repoPath = "/vercel/sandbox";

  readonly calls: FakeExecCall[] = [];
  readonly files = new Map<string, { data: Buffer; mode?: number }>();

  private scripts: ExecScript[] = [];
  private stopped = false;

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
  }
}
