import "server-only";

import { readSandboxBoundedTextFile } from "@/lib/sandbox/bounded-text-file";
import type { SandboxExecOptions, SandboxHandle } from "@/lib/sandbox/types";

type Manager = "npm" | "pnpm" | "yarn" | "bun";
type ValidationSandbox = Pick<SandboxHandle, "exec" | "repoPath">;
const toolingDirectory = "/tmp/wallie-join-package-tools";

const lockfiles = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
} satisfies Record<Manager, string[]>;

const fallbackVersions = {
  pnpm: "10.15.0",
  yarn: "1.22.22",
  bun: "1.3.13",
} as const;

const packageManager =
  /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/;

const quietCommand = 'exec "$@" >/dev/null 2>&1';
const withTools = 'export PATH="$1:$PATH"; shift; exec "$@"';
const installEnvironment = {
  CI: "1",
  NODE_ENV: "development",
  BASH_ENV: "/dev/null",
};

async function required(
  sandbox: ValidationSandbox,
  command: string,
  args: string[],
  signal: AbortSignal,
  { failureMessage, ...options }: SandboxExecOptions & { failureMessage?: string } = {},
) {
  signal.throwIfAborted();
  const process = await sandbox.exec(command, args, {
    cwd: sandbox.repoPath,
    ...options,
    signal,
  });
  const [output, code] = await Promise.all([process.output(), process.exitCode]);
  signal.throwIfAborted();
  if (code !== 0) throw new Error(failureMessage ?? "Could not inspect the joined package files.");
  return output.stdout;
}

function installArguments(manager: Manager, version: string | undefined): string[] {
  switch (manager) {
    case "npm":
      return ["ci", "--include=dev", "--no-audit", "--no-fund"];
    case "pnpm":
      return ["install", "--frozen-lockfile", "--prod=false"];
    case "yarn":
      return version?.startsWith("1.")
        ? ["install", "--frozen-lockfile", "--non-interactive", "--production=false"]
        : ["install", "--immutable"];
    case "bun":
      return ["install", "--frozen-lockfile"];
  }
}

/** Prepare the committed dependency set before running the immutable validation plan. */
export async function prepareJoinValidationDependencies(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<ValidationSandbox> {
  const managers = Object.keys(lockfiles) as Manager[];
  const tracked = new Set(
    (
      await required(
        sandbox,
        "git",
        ["ls-files", "--", "package.json", ...Object.values(lockfiles).flat()],
        signal,
      )
    ).split("\n"),
  );
  if (!tracked.has("package.json")) return sandbox;

  const locked = managers.filter((manager) => lockfiles[manager].some((lock) => tracked.has(lock)));
  const rawManifest = await readSandboxBoundedTextFile({
    sandbox,
    path: sandbox.repoPath + "/package.json",
    maxBytes: 256 * 1024,
    signal,
  });
  if (rawManifest === null) throw new Error("The joined package manifest is unavailable.");
  const manifest = JSON.parse(rawManifest) as { packageManager?: unknown };
  const pinned =
    typeof manifest.packageManager === "string"
      ? packageManager.exec(manifest.packageManager)
      : null;
  if (manifest.packageManager !== undefined && !pinned)
    throw new Error("The joined repository has an unsupported package manager pin.");
  const manager = pinned ? (pinned[1] as Manager) : locked[0];
  const version =
    pinned?.[2] ?? (manager && manager !== "npm" ? fallbackVersions[manager] : undefined);
  if ((pinned && locked.length && !locked.includes(manager)) || (!pinned && locked.length > 1))
    throw new Error("The joined repository has conflicting package manager lockfiles.");
  if (!manager) return sandbox;

  const verifyDigest = Boolean(pinned?.[3]);
  if (verifyDigest && manager === "bun")
    throw new Error("The join worker cannot verify hash-qualified Bun pins.");
  const toolEnvironment: Record<string, string> = {};
  if (pinned && manager === "yarn") toolEnvironment.YARN_IGNORE_PATH = "1";
  if (verifyDigest) {
    toolEnvironment.COREPACK_HOME = toolingDirectory + "/cache";
    toolEnvironment.COREPACK_ENV_FILE = "0";
    toolEnvironment.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  }

  const preparedSandbox: ValidationSandbox = version
    ? {
        repoPath: sandbox.repoPath,
        exec: (command, args, options) =>
          sandbox.exec(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-c",
              withTools,
              "--",
              toolingDirectory + "/bin",
              command,
              ...args,
            ],
            { ...options, env: { ...options?.env, ...toolEnvironment } },
          ),
      }
    : sandbox;
  if (version) {
    const tool = manager === "yarn" && !version.startsWith("1.") ? "@yarnpkg/cli-dist" : manager;
    await required(
      sandbox,
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        quietCommand,
        "--",
        "npm",
        "install",
        "--global",
        "--prefix",
        toolingDirectory,
        "--registry=https://registry.npmjs.org",
        "--userconfig=/dev/null",
        "--no-audit",
        "--no-fund",
        verifyDigest ? "corepack@0.34.5" : tool + "@" + version,
      ],
      signal,
      {
        cwd: "/tmp",
        env: installEnvironment,
        failureMessage: `Could not provision ${manager} for joined validation.`,
      },
    );
  }

  if (verifyDigest) {
    // Corepack reads the exact packageManager pin and verifies its artifact digest.
    await required(
      preparedSandbox,
      "bash",
      ["--noprofile", "--norc", "-c", quietCommand, "--", "corepack", "install"],
      signal,
      {
        env: installEnvironment,
        failureMessage: `Could not verify the repository’s ${manager} pin for joined validation.`,
      },
    );
    await required(
      preparedSandbox,
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        quietCommand,
        "--",
        "corepack",
        "enable",
        "--install-directory",
        toolingDirectory + "/bin",
        manager,
      ],
      signal,
      {
        env: installEnvironment,
        failureMessage: `Could not activate ${manager} for joined validation.`,
      },
    );
  }

  if (locked.includes(manager)) {
    await required(
      preparedSandbox,
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        quietCommand,
        "--",
        manager,
        ...installArguments(manager, version),
      ],
      signal,
      {
        env: installEnvironment,
        failureMessage: `Could not install the joined repository’s locked dependencies with ${manager}.`,
      },
    );
  }
  return preparedSandbox;
}
