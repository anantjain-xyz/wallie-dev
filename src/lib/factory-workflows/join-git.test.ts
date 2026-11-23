import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

import { integrateJoin, type JoinPlan } from "./join-git";

const runFile = promisify(execFile);
const env = {
  ...process.env,
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_AUTHOR_NAME: "Wallie fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_AUTHOR_DATE: "2026-11-22T07:00:00Z",
  GIT_COMMITTER_NAME: "Wallie fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
  GIT_COMMITTER_DATE: "2026-11-22T07:00:00Z",
};
const parentRun = "00000000-0000-4000-8000-000000000251";
const leftRun = "00000000-0000-4000-8000-000000000252";
const rightRun = "00000000-0000-4000-8000-000000000253";
const fixtureJoin = "00000000-0000-4000-8000-000000000254";

async function result(
  cwd: string,
  args: string[],
  options?: { signal?: AbortSignal; environment?: Record<string, string> },
) {
  try {
    const output = await runFile("git", args, {
      cwd,
      env: { ...env, ...options?.environment },
      signal: options?.signal,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: output.stdout, code: 0 };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return { stdout: error.stdout, code: error.code };
    }
    throw error;
  }
}
async function git(cwd: string, args: string[]) {
  const output = await result(cwd, args);
  assert.equal(output.code, 0, args.join(" "));
  return output.stdout.trim();
}

async function fixture(
  run: (ctx: {
    root: string;
    origin: string;
    plan: JoinPlan;
    baseSha: string;
    leftSha: string;
    rightSha: string;
    conflictingSha: string;
    integrate: (plan: JoinPlan, tag: string) => ReturnType<typeof integrateJoin>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "wallie-join-git-"));
  try {
    const origin = join(root, "origin");
    const checkout = join(root, "checkout");
    await mkdir(origin);
    await mkdir(checkout);
    await git(origin, ["init", "--bare", "--template=", "--quiet"]);
    await git(checkout, ["init", "--initial-branch=main", "--template=", "--quiet"]);
    await writeFile(join(checkout, "a file.txt"), "base\n");
    await writeFile(join(checkout, "b file.txt"), "base\n");
    await git(checkout, ["add", "."]);
    await git(checkout, ["commit", "-qm", "base"]);
    const baseSha = await git(checkout, ["rev-parse", "HEAD"]);
    const retained = (runId: string, sha: string) =>
      "refs/heads/wallie/checkpoints/" + runId + "/" + sha;
    const parentRef = retained(parentRun, baseSha);
    async function branch(file: string, text: string, runId: string) {
      await git(checkout, ["checkout", "--detach", baseSha]);
      await writeFile(join(checkout, file), text + "\n");
      await git(checkout, ["commit", "-qam", text]);
      const sha = await git(checkout, ["rev-parse", "HEAD"]);
      const ref = retained(runId, sha);
      await git(checkout, ["push", origin, "HEAD:" + ref]);
      return { sha, ref };
    }
    await git(checkout, ["push", origin, baseSha + ":refs/heads/main", baseSha + ":" + parentRef]);
    const left = await branch("a file.txt", "left", leftRun);
    const right = await branch("b file.txt", "right", rightRun);
    const conflict = await branch("a file.txt", "conflict", rightRun);
    const plan: JoinPlan = {
      joinId: fixtureJoin,
      admittedAt: "2026-11-22T20:05:00.123+00:00",
      parent: {
        checkpointRunId: parentRun,
        outputSha: baseSha,
        retainedRef: parentRef,
      },
      branches: [
        {
          edgeId: "branch.right",
          checkpointRunId: rightRun,
          inputSha: baseSha,
          outputSha: right.sha,
          retainedRef: right.ref,
        },
        {
          edgeId: "branch.left",
          checkpointRunId: leftRun,
          inputSha: baseSha,
          outputSha: left.sha,
          retainedRef: left.ref,
        },
      ],
    };
    await run({
      root,
      origin,
      plan,
      baseSha,
      leftSha: left.sha,
      rightSha: right.sha,
      conflictingSha: conflict.sha,
      async integrate(input, tag) {
        const cwd = join(root, tag);
        await mkdir(cwd);
        return integrateJoin(
          input,
          {
            git: (args, opts) => result(cwd, args, { signal: opts.signal, environment: opts.env }),
            async fetch(selector, signal) {
              const fetched = await result(
                cwd,
                ["fetch", "--no-tags", "--no-recurse-submodules", origin, selector],
                { signal },
              );
              assert.equal(fetched.code, 0);
            },
          },
          AbortSignal.timeout(30_000),
        );
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("the same exact named input set creates a repeatable joined commit without moving the parent", async () =>
  fixture(async ({ root, origin, plan, integrate, baseSha, leftSha, rightSha }) => {
    const initial = await integrate(plan, "first");
    const replay = await integrate({ ...plan, branches: plan.branches.toReversed() }, "replay");
    assert.deepEqual(initial, replay);
    assert.equal(initial.kind, "candidate");
    const cwd = join(root, "first");
    assert.equal(await git(cwd, ["show", initial.commitSha + ":a file.txt"]), "left");
    assert.equal(await git(cwd, ["show", initial.commitSha + ":b file.txt"]), "right");
    assert.equal(await git(cwd, ["rev-parse", initial.commitSha + "^{tree}"]), initial.treeSha);
    for (const known of [baseSha, leftSha, rightSha])
      await git(cwd, ["merge-base", "--is-ancestor", known, initial.commitSha]);
    assert.equal(await git(origin, ["rev-parse", "refs/heads/main"]), baseSha);
  }));
test("a conflict publishes no candidate and returns the exact incoming branch and unquoted path", async () =>
  fixture(async ({ origin, plan, integrate, baseSha, conflictingSha }) => {
    const right = plan.branches[0]!;
    const outcome = await integrate(
      {
        ...plan,
        branches: [
          {
            ...right,
            outputSha: conflictingSha,
            retainedRef: "refs/heads/wallie/checkpoints/" + rightRun + "/" + conflictingSha,
          },
          plan.branches[1]!,
        ],
      },
      "conflict",
    );
    assert.equal(outcome.kind, "conflict");
    assert.equal(outcome.edgeId, "branch.right");
    assert.equal(outcome.incomingSha, conflictingSha);
    assert.deepEqual(outcome.paths, ["a file.txt"]);
    assert.equal(outcome.pathsTruncated, false);
    assert.equal(await git(origin, ["rev-parse", "refs/heads/main"]), baseSha);
  }));
test("retained ref drift, another run's ref, and unrelated input fail before candidate creation", async () =>
  fixture(async ({ origin, plan, integrate, conflictingSha, leftSha, rightSha }) => {
    const right = plan.branches[0]!;
    await assert.rejects(
      integrate(
        {
          ...plan,
          branches: [{ ...right, checkpointRunId: leftRun }],
        },
        "wrong-producer",
      ),
      /unexpected retained ref/,
    );
    await assert.rejects(
      integrate(
        {
          ...plan,
          branches: [
            ...plan.branches.slice(1),
            { ...right, inputSha: leftSha, outputSha: rightSha },
          ],
        },
        "unrelated-source",
      ),
      /unrelated checkpoint ancestry/,
    );
    await git(origin, ["update-ref", right.retainedRef!, conflictingSha]);
    await assert.rejects(integrate(plan, "moved"), /changed after admission/);
  }));
test("a selected text-only branch with unchanged source produces the exact parent commit", async () =>
  fixture(async ({ root, plan, integrate, baseSha }) => {
    const candidate = await integrate(
      {
        ...plan,
        branches: [{ ...plan.branches[0]!, outputSha: baseSha, retainedRef: null }],
      },
      "no-code",
    );
    assert.equal(candidate.kind, "candidate");
    assert.equal(candidate.commitSha, baseSha);
    assert.equal(
      candidate.treeSha,
      await git(join(root, "no-code"), ["rev-parse", baseSha + "^{tree}"]),
    );
  }));
