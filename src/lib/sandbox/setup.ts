import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "./commit-author";
import { shellQuote } from "./command";
import type { CreateSessionSandboxInput, SandboxHandle, SandboxProvider } from "./types";

const PLAYWRIGHT_SYSTEM_PACKAGES = [
  "alsa-lib",
  "atk",
  "at-spi2-atk",
  "cairo",
  "cups-libs",
  "gtk3",
  "libdrm",
  "libXcomposite",
  "libXdamage",
  "libXfixes",
  "libXrandr",
  "libxkbcommon",
  "mesa-libgbm",
  "nspr",
  "nss",
  "pango",
].join(" ");

const NODE_VERSION_CHECK =
  "node -e " +
  shellQuote(
    "const [major,minor]=process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)",
  );

export async function prepareSessionSandbox(input: {
  handle: SandboxHandle;
  provider: SandboxProvider;
  repoAlreadyCloned: boolean;
  request: CreateSessionSandboxInput;
}): Promise<void> {
  const { handle, provider, repoAlreadyCloned, request } = input;
  const mode = request.mode ?? { kind: "fresh-branch" as const };
  const revision = mode.kind === "checkout-pr" ? mode.prBranch : request.baseBranch;
  const checkoutArgs =
    mode.kind === "fresh-branch"
      ? `checkout -B ${shellQuote(request.branch)}`
      : `checkout ${shellQuote(request.branch)}`;

  const script = [
    "set -euo pipefail",
    `mkdir -p ${shellQuote(handle.repoPath)}`,
    `printf "https://x-access-token:%s@github.com\\n" "$GH_TOKEN" > "$HOME/.git-credentials"`,
    `chmod 600 "$HOME/.git-credentials"`,
    `git config --global credential.helper store`,
    repoAlreadyCloned
      ? "true"
      : [
          `rmdir ${shellQuote(handle.repoPath)} 2>/dev/null || true`,
          `git clone --depth 1 --branch ${shellQuote(revision)} ${shellQuote(`https://github.com/${request.repoFullName}.git`)} ${shellQuote(handle.repoPath)}`,
        ].join(" && "),
    `git -C ${shellQuote(handle.repoPath)} config user.email ${shellQuote(WALLIE_GITHUB_BOT_COMMIT_AUTHOR.email)}`,
    `git -C ${shellQuote(handle.repoPath)} config user.name ${shellQuote(WALLIE_GITHUB_BOT_COMMIT_AUTHOR.name)}`,
    `git -C ${shellQuote(handle.repoPath)} ${checkoutArgs}`,
    resolveMemoryBootstrap(provider),
    resolveNodeBootstrap(provider),
    resolveAgentCliInstall(request.agentProvider),
    resolveBrowserBootstrap(provider),
  ].join(" && ");

  const proc = await handle.exec("bash", ["-lc", script], {
    cwd: "/tmp",
    env: { CI: "1", GH_TOKEN: request.installationToken },
    signal: request.signal,
  });
  const [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  if (code !== 0) {
    throw new Error(`Sandbox setup failed (exit ${code}): ${formatFailureOutput(output)}`);
  }
}

function resolveMemoryBootstrap(provider: SandboxProvider): string {
  if (provider !== "e2b") return "true";

  // E2B's standard base template has 512 MB of RAM. Chromium cannot reserve
  // V8's code range at that limit, even though Hobby accounts allow more
  // memory. A small swap file keeps the zero-config base template usable.
  return `(
    if ! swapon --show=NAME --noheadings 2>/dev/null | grep -Fxq '/tmp/wallie.swap'; then
      sudo fallocate -l 1G /tmp/wallie.swap &&
      sudo chmod 600 /tmp/wallie.swap &&
      sudo mkswap /tmp/wallie.swap >/dev/null &&
      sudo swapon /tmp/wallie.swap
    fi
  )`;
}

function resolveNodeBootstrap(provider: SandboxProvider): string {
  if (provider !== "e2b") return NODE_VERSION_CHECK;

  return `(
    ${NODE_VERSION_CHECK} || (
      if command -v sudo >/dev/null 2>&1; then
        sudo npm install -g n && sudo n 22
      else
        npm install -g n && n 22
      fi &&
      hash -r &&
      ${NODE_VERSION_CHECK}
    )
  )`;
}

function formatFailureOutput(output: { stderr: string; stdout: string }): string {
  const details = [
    output.stderr.trim() ? `stderr: ${output.stderr.trim().slice(-500)}` : null,
    output.stdout.trim() ? `stdout: ${output.stdout.trim().slice(-500)}` : null,
  ].filter(Boolean);
  return details.join("\n") || "(no output)";
}

function resolveBrowserBootstrap(provider: SandboxProvider): string {
  if (provider === "vercel") {
    return `(
      sudo dnf install -y ${PLAYWRIGHT_SYSTEM_PACKAGES} &&
      npm install -g playwright@^1.56.0 &&
      playwright install chromium
    )`;
  }

  return `(
    npm install -g playwright@^1.56.0 &&
    if command -v sudo >/dev/null 2>&1; then sudo playwright install-deps chromium; else playwright install-deps chromium; fi &&
    playwright install chromium
  )`;
}

function resolveAgentCliInstall(provider: CreateSessionSandboxInput["agentProvider"]): string {
  switch (provider) {
    case "codex":
      return "npm install -g @openai/codex";
    case "claude-code":
      return "npm install -g @anthropic-ai/claude-code";
  }
}
