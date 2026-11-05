import "server-only";

import { shellQuote } from "@/lib/sandbox/command";
import type { SandboxHandle } from "@/lib/sandbox/types";

/** Restore the pinned commit even when a fresh shallow clone starts elsewhere. */
export async function checkoutPinnedGitInput(input: {
  sandbox: SandboxHandle;
  branch: string;
  sha: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error("Invalid pinned Git input.");
  input.signal?.throwIfAborted();
  const sha = shellQuote(input.sha);
  const script = [
    "set -euo pipefail",
    // Never substitute the moving default branch when the commit is unavailable.
    `git cat-file -e ${shellQuote(`${input.sha}^{commit}`)} 2>/dev/null || git -c core.hooksPath=/dev/null fetch --no-tags origin ${sha}`,
    `git -c core.hooksPath=/dev/null checkout -B ${shellQuote(input.branch)} ${sha} --`,
    `test "$(git rev-parse --verify 'HEAD^{commit}')" = ${sha}`,
  ].join("\n");
  const process = await input.sandbox.exec("bash", ["-lc", script], {
    cwd: input.sandbox.repoPath,
    signal: input.signal,
  });
  const [, code] = await Promise.all([process.output(), process.exitCode]);
  input.signal?.throwIfAborted();
  if (code !== 0) throw new Error("Could not restore the pinned Git input.");
}
