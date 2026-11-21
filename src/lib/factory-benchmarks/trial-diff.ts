import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import { AgentOutputSafety } from "@/lib/agent-runner/safety";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

import { replayCommitSchema, replaySha256 } from "./replay-contracts";

const maxPatchBytes = 65_536;
const maxSensitivePromptBytes = 32 * 1024;
const captureTimeoutMs = 3_000;
const stageTimeoutMs = 1_000;
const settlementHeadroomMs = 4_000;

type CommitIdentity = { commitSha: string; treeSha: string };
type DiffIdentity = { input: CommitIdentity; output: CommitIdentity };

const readDiffScript = String.raw`
const { execFileSync } = require("node:child_process");
const [base, baseTree, head, headTree] = process.argv.slice(1);
function git(...args) {
  return execFileSync("git", [
    "--no-pager", "--no-optional-locks",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.quotePath=true",
    "-c", "diff.suppressBlankEmpty=false",
    ...args,
  ], { timeout: 1500, maxBuffer: ${maxPatchBytes}, stdio: ["ignore", "pipe", "pipe"] });
}
try {
  if (git("rev-parse", "--verify", base + "^{tree}").toString().trim() !== baseTree ||
      git("rev-parse", "--verify", head + "^{tree}").toString().trim() !== headTree) {
    process.exit(1);
  }
  const bytes = git(
    "diff", "--patch", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    "--submodule=short", "--ignore-submodules=none", "--src-prefix=a/", "--dst-prefix=b/",
    "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
    base, head, "--",
  );
  process.stdout.write(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
} catch {
  process.exit(1);
}
`;

/** Known replay text is optional evidence input and never goes to the Git command. */
export function benchmarkEvidenceSensitiveValues(prompt: string): string[] | null {
  if (Buffer.byteLength(prompt, "utf8") > maxSensitivePromptBytes) return null;
  const lines = new Set(
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8),
  );
  return lines.size <= 256 ? [prompt, ...lines] : null;
}

export async function readPrivateBenchmarkDiff({
  sandbox,
  signal,
  deadlineMs,
  commits,
  sensitiveValues,
}: {
  sandbox: Pick<SandboxHandle, "exec" | "repoPath">;
  signal: AbortSignal;
  deadlineMs: number;
  commits: DiffIdentity;
  sensitiveValues: readonly string[] | null;
}) {
  const { input, output } = commits;
  if (
    !sensitiveValues ||
    input.commitSha === output.commitSha ||
    input.treeSha === output.treeSha ||
    ![input.commitSha, input.treeSha, output.commitSha, output.treeSha].every(
      (value) => replayCommitSchema.safeParse(value).success,
    ) ||
    Date.now() + captureTimeoutMs + settlementHeadroomMs >= deadlineMs
  )
    return null;

  const localSignal = AbortSignal.any([signal, AbortSignal.timeout(captureTimeoutMs)]);
  try {
    const { stdout } = await observeUntilAbort(localSignal, async () => {
      const process = await sandbox.exec(
        "env",
        [
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "HOME=/tmp",
          "LANG=C",
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_NO_REPLACE_OBJECTS=1",
          "GIT_NO_LAZY_FETCH=1",
          "GIT_ALLOW_PROTOCOL=",
          "GIT_TERMINAL_PROMPT=0",
          "node",
          "-e",
          readDiffScript,
          input.commitSha,
          input.treeSha,
          output.commitSha,
          output.treeSha,
        ],
        { cwd: sandbox.repoPath, signal: localSignal },
      );
      const [status, commandOutput] = await Promise.all([process.exitCode, process.output()]);
      if (status !== 0) throw new Error("The exact local diff is unavailable.");
      return commandOutput;
    });
    if (
      !stdout.startsWith("diff --git ") ||
      !stdout.endsWith("\n") ||
      Buffer.byteLength(stdout, "utf8") > maxPatchBytes ||
      Array.from(stdout).some((value) => {
        const code = value.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      }) ||
      /^(?:Binary files |GIT binary patch|[ +-]Subproject commit )/m.test(stdout)
    )
      return null;

    const redacted = redactRunSensitiveText(
      new AgentOutputSafety([...sensitiveValues]).redact(stdout),
    );
    const lines = stdout.split("\n");
    const safeLines = redacted.split("\n");
    // Retain the hunk structure and exact file identity. Multiline redactions and
    // sensitive filenames can make a valid Git patch misleading, so omit it.
    if (
      safeLines.length !== lines.length ||
      lines.some((line, i) => {
        if (line === safeLines[i]) return false;
        return (
          !/^[ +-]/.test(line) || /^(?:--- |\+\+\+ )/.test(line) || line[0] !== safeLines[i]?.[0]
        );
      }) ||
      Buffer.byteLength(redacted, "utf8") > maxPatchBytes
    )
      return null;
    return { ...commits, patch: redacted, sha256: replaySha256(redacted) };
  } catch {
    return null;
  }
}

export async function stagePrivateBenchmarkDiff(
  admin: SupabaseClient<Database>,
  identity: { p_trial_id: string; p_job_id: string; p_run_id: string; p_attempt_count: number },
  captured: Awaited<ReturnType<typeof readPrivateBenchmarkDiff>>,
  signal: AbortSignal,
  deadlineMs: number,
) {
  if (!captured || Date.now() + stageTimeoutMs + settlementHeadroomMs >= deadlineMs) return;
  const localSignal = AbortSignal.any([signal, AbortSignal.timeout(stageTimeoutMs)]);
  await observeUntilAbort(localSignal, async () =>
    admin
      .rpc("stage_factory_benchmark_trial_diff", {
        ...identity,
        p_input_commit_sha: captured.input.commitSha,
        p_input_tree_sha: captured.input.treeSha,
        p_output_commit_sha: captured.output.commitSha,
        p_output_tree_sha: captured.output.treeSha,
        p_patch: captured.patch,
        p_patch_sha256: captured.sha256,
      })
      .abortSignal(localSignal),
  ).catch(() => undefined);
}
