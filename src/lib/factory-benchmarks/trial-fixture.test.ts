import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restoreRetryCheckpoint } from "@/lib/pipeline/retry-checkpoint-git";
import { FakeSandbox } from "@/lib/sandbox/fake";

import { replaySha256 } from "./replay-contracts";
import { recordedTrialFixtureSchema, runRecordedTrialFixture } from "./trial-fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  cleanup.push(() => sandbox.stop());
  const dir = mkdtempSync(join(tmpdir(), "wallie-trial-input-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: sandbox.repoPath, encoding: "utf8" }).trim();
  const sourcePath = "benchmark-input.txt";
  writeFileSync(join(sandbox.repoPath, sourcePath), "before\nsecond\nthird\n");
  git("add", "--", sourcePath);
  git("commit", "-qm", "Add the captured text fixture");
  const inputCommitSha = git("rev-parse", "HEAD^{commit}");
  const inputTreeSha = git("rev-parse", "HEAD^{tree}");
  const inputPath = join(dir, "inputs.json");
  const originalPrompt = "Count the lines in benchmark-input.txt.";
  const body = JSON.stringify({ version: 1, text: { originalPrompt } });
  writeFileSync(inputPath, body, { mode: 0o600 });
  return {
    sandbox,
    git,
    run: {
      sandbox,
      signal: AbortSignal.timeout(20_000),
      inputPath,
      inputBundleSha256: replaySha256(body),
      inputCommitSha,
      inputTreeSha,
      fixture: recordedTrialFixtureSchema.parse({
        version: 1,
        operation: "count_utf8_lines",
        promptSha256: replaySha256(originalPrompt),
        checkoutSha: inputCommitSha,
        sourcePath,
        expectedLineCount: 3,
      }),
    },
  };
}

describe("sealed benchmark fixture candidate", () => {
  it("derives the output from the pinned Git blob and retains a restorable reproducible commit", async () => {
    const { sandbox, git, run } = await fixture();
    const first = await runRecordedTrialFixture(run);
    expect(first.artifactMarkdown).toBe("Counted 3 lines in `benchmark-input.txt`.");
    expect(first.checkpoint.baseSha).toBe(run.inputCommitSha);
    expect(first.checkpoint.headSha).toBe(git("rev-parse", "HEAD^{commit}"));
    expect(first.validation).toMatchObject({
      status: "passed",
      treeSha: git("rev-parse", "HEAD^{tree}"),
    });
    expect(sandbox.calls.every(({ opts }) => opts.env === undefined)).toBe(true);

    git("reset", "--hard", run.inputCommitSha);
    const second = await runRecordedTrialFixture(run);
    expect(second.checkpoint.sha256).toBe(first.checkpoint.sha256);
    expect(second.validation).toEqual(first.validation);

    git("reset", "--hard", run.inputCommitSha);
    await restoreRetryCheckpoint({
      sandbox,
      signal: run.signal,
      baseSha: run.inputCommitSha,
      headSha: second.checkpoint.headSha,
      bytes: second.checkpoint.bytes,
      sha256: second.checkpoint.sha256,
    });
    expect(git("rev-parse", "HEAD^{tree}")).toBe(first.validation.treeSha);
    expect(git("show", "HEAD:.wallie-benchmark-result.json")).toBe(
      '{"version":1,"path":"benchmark-input.txt","lines":3}',
    );
  }, 20_000);

  it("rejects mismatched inputs before mutating the source", async () => {
    const { git, run } = await fixture();
    await expect(
      runRecordedTrialFixture({ ...run, inputBundleSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "candidate_failed" });
    await expect(
      runRecordedTrialFixture({
        ...run,
        fixture: { ...run.fixture, promptSha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "candidate_failed" });
    await expect(
      runRecordedTrialFixture({ ...run, inputTreeSha: "0".repeat(40) }),
    ).rejects.toMatchObject({ code: "candidate_failed" });
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(run.inputCommitSha);
  });

  it("does not retain a candidate whose locally measured result disagrees with the fixture", async () => {
    const { run } = await fixture();
    await expect(
      runRecordedTrialFixture({
        ...run,
        fixture: { ...run.fixture, expectedLineCount: 4 },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
