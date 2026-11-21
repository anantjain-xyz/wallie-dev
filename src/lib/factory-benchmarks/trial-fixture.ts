import "server-only";

import { z } from "zod";

import { captureCommittedSourceCheckpoint } from "@/lib/pipeline/source-checkpoint";
import { shellQuote } from "@/lib/sandbox/command";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import type { SandboxHandle } from "@/lib/sandbox/types";
import {
  captureValidationEvidence,
  readValidationIdentity,
} from "@/lib/validation-evidence/capture";
import { validationPlanSchema } from "@/lib/validation-evidence/contracts";

import { replayCommitSchema, replayDigestSchema, replaySha256 } from "./replay-contracts";

export const RECORDED_FIXTURE_RUNNER = "recorded-fixture-v1";
export const RECORDED_FIXTURE_VALIDATION = "recorded-fixture-output";
const resultPath = ".wallie-benchmark-result.json";
const maxSourceBytes = 256 * 1024;

// The first offline candidate supports a deliberately small task: read an exact
// Git text blob, count its lines, and commit a machine-readable result.
export const recordedTrialFixtureSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("count_utf8_lines"),
  promptSha256: replayDigestSchema,
  checkoutSha: replayCommitSchema,
  sourcePath: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
    .refine((path) => !path.split("/").some((part) => [".", "..", ".git"].includes(part))),
  expectedLineCount: z.number().int().min(0).max(maxSourceBytes),
});

type Fixture = z.infer<typeof recordedTrialFixtureSchema>;
type HarnessSandbox = Pick<SandboxHandle, "exec" | "repoPath" | "writeFile">;
type FixtureFailure = "candidate_failed" | "validation_failed" | "checkpoint_unavailable";
const fixtureErrors = {
  candidate_failed: "The offline benchmark candidate could not run against the pinned input.",
  validation_failed: "The offline benchmark output did not pass checkpoint validation.",
  checkpoint_unavailable: "The private benchmark checkpoint could not be captured.",
} satisfies Record<FixtureFailure, string>;

export class RecordedTrialFixtureError extends Error {
  constructor(readonly code: FixtureFailure) {
    super(fixtureErrors[code]);
    this.name = "RecordedTrialFixtureError";
  }
}

const fixtureGitEnvironment: Readonly<Record<string, string>> = {
  ...WALLIE_GIT_IDENTITY_ENV,
  BASH_ENV: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
};

// Only the shared application checkpoint and validation components use this
// handle. Carry their fixed Git options in env(1) arguments, never provider env.
function validationSandbox(sandbox: HarnessSandbox): HarnessSandbox {
  return {
    repoPath: sandbox.repoPath,
    writeFile: sandbox.writeFile.bind(sandbox),
    exec(cmd, args, { env, ...options } = {}) {
      if (!env) return sandbox.exec(cmd, args, options);
      const variables = Object.entries(env).map(([key, value]) => {
        if (!Object.hasOwn(fixtureGitEnvironment, key) || fixtureGitEnvironment[key] !== value) {
          throw new RecordedTrialFixtureError("checkpoint_unavailable");
        }
        return `${key}=${value}`;
      });
      return sandbox.exec("env", [...variables, cmd, ...args], options);
    },
  };
}

const gitFixtureSource = String.raw`
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args,
], { maxBuffer: ${maxSourceBytes + 4096} });
const text = (...args) => git(...args).toString("utf8").trim();
function lineCount(base, path) {
  const [mode, type] = text("ls-tree", base, "--", path).split(" ");
  assert.ok(["100644", "100755"].includes(mode) && type === "blob");
  const content = git("cat-file", "blob", base + ":" + path);
  assert.ok(content.length <= ${maxSourceBytes} && content.indexOf(0) < 0);
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  return decoded.length ? decoded.split("\n").length - Number(decoded.endsWith("\n")) : 0;
}
`;

const runCandidate = String.raw`
${gitFixtureSource}
const [inputsPath, inputDigest, fixtureJson] = process.argv.slice(1);
const fixture = JSON.parse(fixtureJson);
const bundle = readFileSync(inputsPath);
assert.equal(sha256(bundle), inputDigest);
const restored = JSON.parse(bundle);
assert.equal(restored.version, 1);
assert.equal(sha256(restored.text.originalPrompt), fixture.promptSha256);
assert.equal(text("rev-parse", "HEAD^{commit}"), fixture.checkoutSha);
const lines = lineCount(fixture.checkoutSha, fixture.sourcePath);
const result = JSON.stringify({version: 1, path: fixture.sourcePath, lines}) + "\n";
writeFileSync(${JSON.stringify(resultPath)}, result, { flag: "wx", mode: 0o644 });
git("add", "--", ${JSON.stringify(resultPath)});
const date = "@" + text("show", "-s", "--format=%ct", fixture.checkoutSha) + " +0000";
Object.assign(process.env, ${JSON.stringify(WALLIE_GIT_IDENTITY_ENV)}, {
  GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
});
git("commit", "-m", "Record offline benchmark result");
`;

const validateCandidate = String.raw`
${gitFixtureSource}
const [base, path, expected, expectedDigest] = process.argv.slice(1);
const bytes = git("show", "HEAD:" + ${JSON.stringify(resultPath)});
assert.equal(sha256(bytes), expectedDigest);
const result = JSON.parse(bytes);
assert.deepEqual(result, {version: 1, path, lines: Number(expected)});
assert.equal(lineCount(base, path), Number(expected));
assert.equal(text("rev-parse", "HEAD^"), base);
assert.equal(text("diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"), "A\t" + ${JSON.stringify(resultPath)});
`;

export async function runRecordedTrialFixture(input: {
  sandbox: HarnessSandbox;
  signal: AbortSignal;
  inputPath: string;
  inputBundleSha256: string;
  inputCommitSha: string;
  inputTreeSha: string;
  fixture: Fixture;
}) {
  const { fixture, inputBundleSha256, inputCommitSha, inputPath, inputTreeSha, signal } = input;
  const sandbox = validationSandbox(input.sandbox);
  let outputIdentity: Awaited<ReturnType<typeof readValidationIdentity>>;
  try {
    const start = await readValidationIdentity(sandbox, signal);
    if (
      !start.clean ||
      start.commitSha !== inputCommitSha ||
      start.treeSha !== inputTreeSha ||
      fixture.checkoutSha !== inputCommitSha
    )
      throw new RecordedTrialFixtureError("candidate_failed");
    const command = await sandbox.exec(
      "env",
      [
        "GIT_NO_REPLACE_OBJECTS=1",
        "node",
        "-e",
        runCandidate,
        inputPath,
        inputBundleSha256,
        JSON.stringify(fixture),
      ],
      { signal },
    );
    if ((await command.exitCode) !== 0) throw new RecordedTrialFixtureError("candidate_failed");
    outputIdentity = await readValidationIdentity(sandbox, signal);
    if (!outputIdentity.clean || outputIdentity.commitSha === inputCommitSha) {
      throw new RecordedTrialFixtureError("candidate_failed");
    }
  } catch {
    signal.throwIfAborted();
    throw new RecordedTrialFixtureError("candidate_failed");
  }

  const output =
    JSON.stringify({ version: 1, path: fixture.sourcePath, lines: fixture.expectedLineCount }) +
    "\n";
  try {
    const plan = validationPlanSchema.parse({
      version: 1,
      commands: [
        {
          key: RECORDED_FIXTURE_VALIDATION,
          command: [
            "node",
            "-e",
            validateCandidate,
            inputCommitSha,
            fixture.sourcePath,
            String(fixture.expectedLineCount),
            replaySha256(output),
          ]
            .map(shellQuote)
            .join(" "),
          timeoutSeconds: 10,
          reports: [],
        },
      ],
    });
    const evidence = await captureValidationEvidence({
      sandbox,
      signal,
      plan,
      commitSha: outputIdentity.commitSha,
    });
    if (evidence.treeSha !== outputIdentity.treeSha || evidence.records[0]?.status !== "passed") {
      throw new RecordedTrialFixtureError("validation_failed");
    }
  } catch {
    signal.throwIfAborted();
    throw new RecordedTrialFixtureError("validation_failed");
  }

  try {
    const checkpoint = await captureCommittedSourceCheckpoint({
      sandbox,
      signal,
      baseSha: inputCommitSha,
      headSha: outputIdentity.commitSha,
    });
    if (checkpoint.kind !== "bundle") throw new RecordedTrialFixtureError("checkpoint_unavailable");
    return {
      checkpoint,
      artifactMarkdown: `Counted ${fixture.expectedLineCount} lines in \`${fixture.sourcePath}\`.`,
      validation: {
        version: 1 as const,
        key: RECORDED_FIXTURE_VALIDATION,
        status: "passed" as const,
        commitSha: outputIdentity.commitSha,
        treeSha: outputIdentity.treeSha,
        outputSha256: replaySha256(output),
      },
    };
  } catch {
    signal.throwIfAborted();
    throw new RecordedTrialFixtureError("checkpoint_unavailable");
  }
}
