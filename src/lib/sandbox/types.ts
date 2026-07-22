/**
 * Sandbox abstraction — a per-session Linux microVM used to run the coding
 * agent CLI (Codex or Claude Code). Wraps provider-specific SDKs (Vercel
 * Sandbox, E2B, and Daytona) so the rest of Wallie only depends on this
 * interface.
 */

export interface SandboxExecOptions {
  /** Working directory inside the sandbox. Defaults to the sandbox's repoPath. */
  cwd?: string;
  /** Extra env vars merged on top of the sandbox-wide env. */
  env?: Record<string, string>;
  /** AbortSignal that terminates the command. */
  signal?: AbortSignal;
}

export interface SandboxLogEntry {
  data: string;
  stream: "stdout" | "stderr";
}

/**
 * Handle for a running command inside a sandbox. Mirrors Vercel Sandbox's
 * `Command` shape so the real impl is a thin wrapper. Prefer `output()` for
 * commands that may finish quickly; `logs()` is a forward-only stream and
 * will silently drop output emitted before subscription.
 */
export interface SandboxExecHandle {
  /**
   * Forward-only async iterable of stdout+stderr chunks. NOT line-delimited —
   * callers buffer. This is a live stream, not a replay buffer: short
   * commands can finish before iteration begins, in which case nothing is
   * yielded. Use `output()` for short-lived commands or anywhere subscription
   * timing isn't guaranteed.
   */
  logs(): AsyncIterable<SandboxLogEntry>;
  /**
   * Wait for the command to finish and return its full stdout and stderr.
   * Safe to call regardless of subscription timing — uses the underlying
   * SDK's cached output API.
   */
  output(): Promise<{ stdout: string; stderr: string }>;
  /** Resolves with the process exit code once it finishes. Memoised. */
  exitCode: Promise<number>;
  /** Send a signal to the running process. */
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): Promise<void>;
}

/**
 * Per-session sandbox. Owns one git clone, one working branch, and one
 * long-lived filesystem that persists across multiple `exec()` calls (so
 * multi-turn runs don't need to re-clone).
 */
export interface SandboxHandle {
  /** Provider-specific sandbox ID. Used for logs, cancellation, and cleanup. */
  readonly id: string;
  /** Absolute path inside the VM where the repo is checked out. */
  readonly repoPath: string;
  /**
   * Launch a command. Runs detached and streams logs until exit. Callers must
   * either drain `logs()` or ignore them; either way, awaiting `exitCode`
   * resolves once the process finishes.
   */
  exec(cmd: string, args: string[], opts?: SandboxExecOptions): Promise<SandboxExecHandle>;
  /** Write a file inside the sandbox. Creates parent dirs as needed. */
  writeFile(path: string, data: string | Buffer, opts?: { mode?: number }): Promise<void>;
  /** Read a file as UTF-8 text. Returns null if missing. */
  readFile(path: string): Promise<string | null>;
  /** Stop and destroy the sandbox. Idempotent; safe to call multiple times. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

export type AgentProvider = "codex" | "claude-code";
export type SandboxProvider = "vercel" | "e2b" | "daytona";
export type SandboxImplementation = SandboxProvider | "fake";

export type VercelSandboxCredentials = {
  projectId: string;
  teamId: string;
  token: string;
};

export type E2BSandboxCredentials = {
  apiKey: string;
};

export type DaytonaSandboxCredentials = {
  apiKey: string;
  /** Defaults to Daytona Cloud when omitted. */
  apiUrl?: string;
  target?: string;
};

export type SandboxConnection =
  | {
      credentials: VercelSandboxCredentials;
      provider: "vercel";
      revision: string;
    }
  | {
      credentials: E2BSandboxCredentials;
      provider: "e2b";
      revision: string;
    }
  | {
      credentials: DaytonaSandboxCredentials;
      provider: "daytona";
      revision: string;
    };

export type SandboxCheckoutMode =
  /** Clone baseBranch and create a new `branch` from it (default). */
  | { kind: "fresh-branch" }
  /** Clone and check out an existing PR branch (review phase). */
  | { kind: "checkout-pr"; prBranch: string };

/**
 * Summary of a running sandbox returned by `listRunningSandboxes`. The
 * reaper uses these fields to decide whether a sandbox is an orphan worth
 * stopping (id for cross-reference, createdAt for the grace window).
 */
export interface RunningSandboxSummary {
  id: string;
  status: "paused" | "pending" | "running";
  /** Unix epoch milliseconds — provider-native. */
  createdAt: number;
}

export interface CreateSessionSandboxInput {
  /** Workspace owner metadata. New production callers must provide it. */
  workspaceId?: string;
  sessionId: string;
  /** "owner/name" */
  repoFullName: string;
  /** The branch the agent will work on (push target). */
  branch: string;
  /** The branch to start from when `mode.kind === "fresh-branch"`. */
  baseBranch: string;
  /** Short-lived GitHub App installation token — passed as clone credentials + push credentials. */
  installationToken: string;
  agentProvider: AgentProvider;
  /**
   * Override the configured sandbox implementation. Capability checks use this
   * to prove Vercel Sandbox works even when local dev uses the fake adapter.
   */
  implementation?: SandboxImplementation;
  mode?: SandboxCheckoutMode;
  /** VM wall-clock timeout. Vercel caps at 45min Hobby / 5h Pro. Default: 30min. */
  timeoutMs?: number;
  /** Optional deadline signal used by bounded route handlers. */
  signal?: AbortSignal;
  /** Required for provider-backed session sandboxes. Omitted only by the fake adapter. */
  connection?: SandboxConnection;
  /** Run/check id used only as provider metadata for ownership and diagnostics. */
  ownerId?: string;
  /**
   * Called immediately after the provider sandbox is created and before setup
   * commands run. Use this to persist Wallie ownership for crash cleanup.
   */
  onSandboxCreated?: (metadata: {
    provider: SandboxImplementation;
    sandboxId: string;
  }) => void | Promise<void>;
}

export interface SandboxProviderDriver<Connection extends SandboxConnection = SandboxConnection> {
  create(input: CreateSessionSandboxInput, connection: Connection): Promise<SandboxHandle>;
  listRunning(
    connection: Connection,
    options?: { workspaceId?: string },
  ): Promise<RunningSandboxSummary[]>;
  stopById(sandboxId: string, connection: Connection): Promise<void>;
  validate(connection: Connection): Promise<{ error?: string; ok: boolean }>;
}
