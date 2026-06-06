import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  RunningSandboxSummary,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
  SandboxCommitAuthor,
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

export interface FakeSandboxOptions {
  baseBranch?: string;
  branch?: string;
  commitAuthor?: SandboxCommitAuthor;
  /**
   * When true, commands that are not explicitly scripted execute on the local
   * machine in a temporary git checkout. Unit tests keep this false so
   * unscripted commands remain deterministic empty outputs.
   */
  passthroughExec?: boolean;
}

let fakeSandboxCounter = 0;

export class FakeSandbox implements SandboxHandle {
  readonly id: string;
  readonly repoPath: string;

  readonly calls: FakeExecCall[] = [];
  readonly files = new Map<string, { data: Buffer; mode?: number }>();

  private scripts: ExecScript[] = [];
  private stopped = false;
  private readonly passthroughExec: boolean;
  private readonly tempRoot: string | null;

  constructor(id?: string, opts: FakeSandboxOptions = {}) {
    this.id = id ?? `fake-sandbox-${++fakeSandboxCounter}`;
    this.passthroughExec = opts.passthroughExec ?? false;
    this.tempRoot = this.passthroughExec
      ? mkdtempSync(join(tmpdir(), "wallie-fake-sandbox-"))
      : null;
    this.repoPath = this.tempRoot ?? "/vercel/sandbox";

    if (this.passthroughExec) {
      initializeLocalGitCheckout(this.repoPath, {
        baseBranch: opts.baseBranch ?? "main",
        branch: opts.branch ?? "wallie/fake-stage",
        commitAuthor: opts.commitAuthor ?? { email: "wallie@example.local", name: "Wallie" },
      });
    }

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

    const call: FakeExecCall = { cmd, args, opts: { ...opts, cwd: opts.cwd ?? this.repoPath } };
    this.calls.push(call);

    const idx = this.scripts.findIndex((s) => s.matches(call));
    if (idx < 0 && this.passthroughExec) {
      return execLocalCommand(call);
    }

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

    if (this.passthroughExec) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buf, { mode: opts.mode });
    }
  }

  async readFile(path: string): Promise<string | null> {
    if (this.passthroughExec && existsSync(path)) {
      return readFileSync(path, "utf8");
    }

    const entry = this.files.get(path);
    return entry ? entry.data.toString("utf8") : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tempRoot) {
      rmSync(this.tempRoot, { force: true, recursive: true });
    }
    const entry = fakeRegistry.get(this.id);
    if (entry) entry.status = "stopped";
  }
}

function initializeLocalGitCheckout(
  repoPath: string,
  input: { baseBranch: string; branch: string; commitAuthor: SandboxCommitAuthor },
): void {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# Wallie fake sandbox\n");

  const env = {
    ...localSandboxEnv(repoPath),
    GIT_AUTHOR_EMAIL: input.commitAuthor.email,
    GIT_AUTHOR_NAME: input.commitAuthor.name,
  };
  runGit(repoPath, ["init", "-q"], env);
  runGit(repoPath, ["config", "user.email", input.commitAuthor.email], env);
  runGit(repoPath, ["config", "user.name", input.commitAuthor.name], env);
  runGit(repoPath, ["checkout", "-B", input.baseBranch], env);
  runGit(repoPath, ["add", "README.md"], env);
  runGit(repoPath, ["commit", "-qm", "Initial fake sandbox checkout"], env);
  runGit(repoPath, ["checkout", "-B", input.branch], env);
}

function runGit(repoPath: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", args, { cwd: repoPath, env });
  if (result.error || result.status !== 0) {
    throw new Error(`FakeSandbox git ${args.join(" ")} failed: ${formatSpawnFailure(result)}`);
  }
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  if (result.error) {
    return result.error.message;
  }

  const stderr = result.stderr.toString("utf8").trim();
  if (stderr) {
    return stderr;
  }

  const stdout = result.stdout.toString("utf8").trim();
  if (stdout) {
    return stdout;
  }

  return `exit code ${result.status ?? "unknown"}`;
}

function execLocalCommand(call: FakeExecCall): SandboxExecHandle {
  const entries: SandboxLogEntry[] = [];
  let done = false;
  const waiters: Array<() => void> = [];
  let resolveExitCode: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  function notify() {
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      waiter();
    }
  }

  function append(entry: SandboxLogEntry) {
    entries.push(entry);
    notify();
  }

  function finish(code: number) {
    if (done) return;
    done = true;
    resolveExitCode(code);
    notify();
  }

  const proc = spawn(call.cmd, call.args, {
    cwd: call.opts.cwd,
    env: { ...localSandboxEnv(call.opts.cwd), ...call.opts.env },
    signal: call.opts.signal,
  });

  proc.stdout.on("data", (chunk: Buffer) => {
    append({ data: chunk.toString("utf8"), stream: "stdout" });
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    append({ data: chunk.toString("utf8"), stream: "stderr" });
  });
  proc.on("error", (error) => {
    append({ data: `${error.message}\n`, stream: "stderr" });
    if (error.name === "AbortError") {
      return;
    }
    finish(127);
  });
  proc.on("close", (code, signal) => {
    finish(code ?? exitCodeForSignal(signal));
  });

  return {
    exitCode,
    kill: async (signal = "SIGTERM") => {
      proc.kill(signal);
    },
    logs: async function* () {
      let index = 0;
      while (!done || index < entries.length) {
        while (index < entries.length) {
          yield entries[index++]!;
        }
        if (!done) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      }
    },
    output: async () => {
      await exitCode;
      let stdout = "";
      let stderr = "";
      for (const entry of entries) {
        if (entry.stream === "stdout") stdout += entry.data;
        else stderr += entry.data;
      }
      return { stdout, stderr };
    },
  };
}

function localSandboxEnv(home: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home ?? tmpdir(),
    NODE_ENV: process.env.NODE_ENV ?? "development",
    TMPDIR: tmpdir(),
  };

  if (process.env.PATH) {
    env.PATH = process.env.PATH;
  }

  return env;
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}
