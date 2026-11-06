/**
 * Hermetic execution smoke using a temporary worktree of wallie-dev itself.
 * No remote refs, repositories, production settings, or credentials are used.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { captureSourceCheckpoint } from "../src/lib/pipeline/source-checkpoint";
import { shellQuote } from "../src/lib/sandbox/command";
import type { SandboxHandle } from "../src/lib/sandbox/types";
import { captureValidationEvidence } from "../src/lib/validation-evidence/capture";

const exec = promisify(execFile);
const SECRET = "synthetic-evidence-smoke-secret-507";
const FIXTURE = "wallie-validation-evidence-smoke.txt";

/** Minimal real-process adapter; it carries only this smoke's synthetic secret. */
function localSandbox(repoPath: string, homePath: string): SandboxHandle {
  return {
    id: "local-wallie-dev-evidence-smoke",
    repoPath,
    async exec(command, args, options = {}) {
      const child = spawn(command, args, {
        cwd: options.cwd ?? repoPath,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: homePath,
          NODE_ENV: "test",
          CI: "1",
          WALLIE_SMOKE_SECRET: SECRET,
          ...options.env,
        },
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 128));
      });
      return {
        exitCode,
        output: async () => {
          await exitCode;
          return { stdout, stderr };
        },
        async *logs() {
          await exitCode;
          if (stdout) yield { data: stdout, stream: "stdout" as const };
          if (stderr) yield { data: stderr, stream: "stderr" as const };
        },
        async kill(signal = "SIGTERM") {
          child.kill(signal);
        },
      };
    },
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeFile(path, data, options) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, options);
    },
    async stop() {},
  };
}

async function main() {
  const source = (
    await exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
  ).stdout.trim();
  const origin = (await exec("git", ["remote", "get-url", "origin"], { cwd: source })).stdout
    .trim()
    .replace(/\.git$/, "");
  assert.match(
    origin,
    /^(?:https:\/\/github\.com\/|git@github\.com:)anantjain-xyz\/wallie-dev$/,
    "Run this smoke from the existing wallie-dev checkout.",
  );
  const directory = await mkdtemp(join(tmpdir(), "wallie-evidence-smoke-"));
  const checkout = join(directory, "checkout");
  const home = join(directory, "home");
  const branch = `wallie/op-507-evidence-smoke-${randomUUID()}`;
  let worktreeCreated = false;
  let branchCreated = false;
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: checkout })
    ).stdout.trim();
  try {
    await mkdir(home);
    await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, checkout, "HEAD"],
      { cwd: source },
    );
    worktreeCreated = true;
    branchCreated = true;
    await mkdir(join(checkout, ".wallie"), { recursive: true });
    await writeFile(join(checkout, FIXTURE), "verified source\n");
    const passingScript = [
      'const fs = require("node:fs");',
      `require("node:assert/strict").equal(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"), "verified source\\n");`,
      "fs.writeFileSync(`${process.env.WALLIE_EVIDENCE_DIR}/tests.txt`, `tests passed ${process.env.WALLIE_SMOKE_SECRET}\\n`);",
      "console.log(`tests passed ${process.env.WALLIE_SMOKE_SECRET}`);",
    ].join("\n");
    const laterEditScript = [
      'const fs = require("node:fs");',
      `require("node:assert/strict").equal(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"), "verified source\\n");`,
      'console.log("tests passed before the later code edit");',
      `fs.appendFileSync(${JSON.stringify(FIXTURE)}, "later code edit\\n");`,
    ].join("\n");
    await writeFile(
      join(checkout, ".wallie/validation-evidence.json"),
      JSON.stringify({
        version: 1,
        commands: [
          {
            key: "smoke-pass",
            command: `node -e ${shellQuote(passingScript)}`,
            timeoutSeconds: 10,
            reports: [{ key: "tests", path: "tests.txt", required: true, kind: "report" }],
          },
          {
            key: "smoke-later-edit",
            command: `node -e ${shellQuote(laterEditScript)}`,
            timeoutSeconds: 10,
            reports: [],
          },
        ],
      }),
    );
    await git("add", "--", FIXTURE);
    await git("add", "-f", "--", ".wallie/validation-evidence.json");
    await git(
      "-c",
      "user.name=Wallie evidence smoke",
      "-c",
      "user.email=noreply@wallie.dev",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Add synthetic validation evidence fixture",
    );
    const commitSha = await git("rev-parse", "HEAD");
    const treeSha = await git("rev-parse", "HEAD^{tree}");
    const sandbox = localSandbox(checkout, home);
    const evidence = await captureValidationEvidence({
      sandbox,
      commitSha,
      secrets: [SECRET],
      signal: AbortSignal.timeout(60_000),
    });
    const passing = evidence.records.find((record) => record.key === "smoke-pass");
    const laterEdit = evidence.records.find((record) => record.key === "smoke-later-edit");
    assert.equal(passing?.exitCode, 0, "The harness must observe the passing test exit.");
    assert.equal(passing?.commitSha, commitSha);
    assert.equal(passing?.treeSha, treeSha);
    assert.equal(laterEdit?.exitCode, 0, "Tests actually pass before the later edit.");
    assert.equal(laterEdit?.status, "stale", "A post-test edit must invalidate validation.");
    assert.ok(evidence.assets.some((asset) => asset.kind === "report" && asset.required));
    for (const asset of evidence.assets) {
      assert.ok(!asset.bytes.includes(Buffer.from(SECRET)), "Captured assets must redact secrets.");
    }
    assert.ok(evidence.assets.some((asset) => asset.bytes.toString("utf8").includes("[REDACTED]")));
    const laterCheckpoint = await captureSourceCheckpoint({ sandbox, baseSha: commitSha });
    assert.notEqual(laterCheckpoint.headSha, commitSha, "The later edit must be retained.");
    assert.notEqual(await git("rev-parse", "HEAD^{tree}"), passing?.treeSha);
    console.log(
      JSON.stringify({
        repository: "anantjain-xyz/wallie-dev",
        execution: "observed",
        commitSha,
        treeSha,
        passingExitCode: passing?.exitCode,
        afterEditExitCode: laterEdit?.exitCode,
        afterEditStatus: laterEdit?.status,
        laterCheckpointSha: laterCheckpoint.headSha,
        earlierEvidenceMatchesLaterCheckpoint: false,
        requiredReport: "captured",
        redaction: "verified",
        assets: evidence.assets.length,
      }),
    );
  } finally {
    if (worktreeCreated) {
      await exec("git", ["worktree", "remove", "--force", checkout], { cwd: source });
    }
    if (branchCreated) await exec("git", ["branch", "-D", branch], { cwd: source });
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(() => {
  console.error("Validation evidence smoke failed; no production settings were changed.");
  process.exitCode = 1;
});
