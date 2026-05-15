import { Sandbox } from "@vercel/sandbox";

import type {
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
} from "./types";

const REPO_PATH = "/vercel/sandbox";
const CODEX_HOME = `${REPO_PATH}/.codex`;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Vercel Sandbox-backed implementation of `SandboxHandle`.
 *
 * Requires `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` in env
 * (unless running on Vercel infra, in which case OIDC is used).
 */
class VercelSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;

  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    const command = await this.sandbox.runCommand({
      cmd,
      args,
      cwd: opts.cwd ?? REPO_PATH,
      env: opts.env,
      detached: true,
      signal: opts.signal,
    });

    const waitPromise = command.wait().then((r) => r.exitCode);

    return {
      logs: () => command.logs() as AsyncIterable<SandboxLogEntry>,
      exitCode: waitPromise,
      kill: async (signal) => {
        await command.kill(signal);
      },
    };
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    opts: { mode?: number } = {},
  ): Promise<void> {
    const content = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await this.sandbox.writeFiles([{ path, content, mode: opts.mode }]);
  }

  async readFile(path: string): Promise<string | null> {
    const buf = await this.sandbox.readFileToBuffer({ path });
    return buf ? buf.toString("utf8") : null;
  }

  async stop(): Promise<void> {
    try {
      await this.sandbox.stop();
    } catch {
      // Already stopped or network hiccup; stop() is supposed to be idempotent.
    }
  }
}

/**
 * Boot a Vercel Sandbox for a session: clone the repo with the GH App token,
 * check out the working branch, install the chosen agent CLI, and (for Codex)
 * materialise an auth.json containing the OAuth access token.
 */
export async function createVercelSessionSandbox(
  input: CreateSessionSandboxInput,
): Promise<SandboxHandle> {
  const mode = input.mode ?? { kind: "fresh-branch" as const };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const revision = mode.kind === "checkout-pr" ? mode.prBranch : input.baseBranch;

  const credentials = resolveVercelCredentials();

  const sandbox = await Sandbox.create({
    ...credentials,
    source: {
      type: "git",
      url: `https://github.com/${input.repoFullName}.git`,
      username: "x-access-token",
      password: input.installationToken,
      revision,
      depth: 1,
    },
    runtime: "node22",
    timeout: timeoutMs,
    resources: { vcpus: 2 },
    env: {
      CI: "1",
      // Used by the setup script + any subsequent git op.
      GH_TOKEN: input.installationToken,
    },
  });

  const handle = new VercelSandboxHandle(sandbox);

  try {
    await runSetup(handle, input, mode.kind);

    if (input.agentProvider === "codex") {
      if (!input.codexAccessToken) {
        throw new Error("Codex provider requires codexAccessToken");
      }
      await handle.writeFile(
        `${CODEX_HOME}/auth.json`,
        JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: { access_token: input.codexAccessToken },
        }),
        { mode: 0o600 },
      );
    }
  } catch (err) {
    await handle.stop();
    throw err;
  }

  return handle;
}

async function runSetup(
  handle: SandboxHandle,
  input: CreateSessionSandboxInput,
  modeKind: "fresh-branch" | "checkout-pr",
): Promise<void> {
  // Expanded after a `git -C <repo>` prefix, so don't prepend another `git`.
  const checkoutArgs =
    modeKind === "fresh-branch"
      ? `checkout -B ${shellQuote(input.branch)}`
      : `checkout ${shellQuote(input.branch)}`;

  const installCmd = resolveAgentCliInstall(input.agentProvider);
  const browserBootstrapCmd = resolveBrowserBootstrap();

  // Single shell invocation: configure git identity + credential helper + CLI install.
  // Credentials: the clone URL already embeds `x-access-token:$GH_TOKEN`, so
  // `git push` on the same remote reuses them — but git writes a redacted URL
  // in .git/config. Store the token in a credential helper as a belt-and-suspenders.
  const script = [
    `set -euo pipefail`,
    `git -C ${shellQuote(REPO_PATH)} config user.email "wallie@wallie.cc"`,
    `git -C ${shellQuote(REPO_PATH)} config user.name "Wallie"`,
    `git -C ${shellQuote(REPO_PATH)} ${checkoutArgs}`,
    `printf "https://x-access-token:%s@github.com\\n" "$GH_TOKEN" > $HOME/.git-credentials`,
    `chmod 600 $HOME/.git-credentials`,
    `git config --global credential.helper store`,
    installCmd,
    browserBootstrapCmd,
  ].join(" && ");

  const proc = await handle.exec("bash", ["-lc", script]);
  const stderr: string[] = [];
  for await (const log of proc.logs()) {
    if (log.stream === "stderr") stderr.push(log.data);
  }
  const code = await proc.exitCode;
  if (code !== 0) {
    throw new Error(
      `Sandbox setup failed (exit ${code}): ${stderr.join("").slice(0, 500) || "(no stderr)"}`,
    );
  }
}

function resolveBrowserBootstrap(): string {
  if (process.env.WALLIE_SANDBOX_BOOTSTRAP_PLAYWRIGHT === "0") {
    return "true";
  }

  // Best-effort: code-only stages should not fail if browser bootstrap is
  // unavailable, but screenshot-capable sandboxes should have Playwright and
  // Chromium ready whenever the base image allows it.
  return "(npm install -g playwright@^1.56.0 && playwright install chromium) || true";
}

function resolveAgentCliInstall(provider: CreateSessionSandboxInput["agentProvider"]): string {
  switch (provider) {
    case "codex":
      return "npm install -g @openai/codex";
    case "claude-code":
      return "npm install -g @anthropic-ai/claude-code";
    case "anthropic-api":
      // No CLI to install — runner calls the Messages API directly.
      // Pipeline normally skips sandbox provisioning for this provider; this
      // branch only fires if a caller explicitly requests a sandbox anyway.
      return "true";
  }
}

function resolveVercelCredentials():
  | { token: string; teamId: string; projectId: string }
  | Record<string, never> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  // Fall back to OIDC (expected when running on Vercel infra).
  return {};
}

/**
 * Best-effort stop of a sandbox by ID. Used by the stall sweep and the
 * sandbox reaper to terminate orphans whose owning run is no longer active.
 *
 * Errors are swallowed: the sandbox may already be stopped, the ID may be
 * stale, or the network may be flaky. Stop is supposed to be idempotent;
 * losing one cleanup is far better than crashing the sweep timer.
 */
export async function stopVercelSandboxById(sandboxId: string): Promise<void> {
  try {
    const sandbox = await Sandbox.get({
      ...resolveVercelCredentials(),
      sandboxId,
    });
    await sandbox.stop();
  } catch (error) {
    console.error("[sandbox] failed to stop sandbox", {
      error: error instanceof Error ? error.message : String(error),
      sandboxId,
    });
  }
}

/**
 * List sandboxes in the current Vercel project. Used by the reaper to find
 * orphans. Returns only sandboxes in active states (`pending` or `running`)
 * — terminal states do not need cleanup.
 */
export async function listRunningVercelSandboxes(): Promise<RunningSandboxSummary[]> {
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) {
    // Without a project ID we cannot list. Caller treats this as "nothing to
    // reap" rather than an error so the worker doesn't hard-fail on dev/test
    // environments without Vercel creds.
    return [];
  }

  try {
    const result = await Sandbox.list({
      ...resolveVercelCredentials(),
      projectId,
      limit: 100,
    });
    const sandboxes = result.json.sandboxes;
    return sandboxes
      .filter((s) => s.status === "pending" || s.status === "running")
      .map((s) => ({
        id: s.id,
        status: s.status as "pending" | "running",
        createdAt: s.createdAt,
      }));
  } catch (error) {
    console.error("[sandbox] failed to list sandboxes", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
