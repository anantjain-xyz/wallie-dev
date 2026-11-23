import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

import type { SandboxHandle } from "@/lib/sandbox/types";
import { integrateJoin, runBoundedJoinMerge, type JoinPlan } from "./join-git";

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
  options?: {
    signal?: AbortSignal;
    environment?: Record<string, string>;
    program?: string;
    maxBuffer?: number;
  },
) {
  try {
    const output = await runFile(options?.program ?? "git", args, {
      cwd,
      env: { ...env, ...options?.environment },
      signal: options?.signal,
      maxBuffer: options?.maxBuffer ?? 1024 * 1024,
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

function localSandbox(cwd: string): Pick<SandboxHandle, "exec"> {
  return {
    async exec(program, args, options) {
      const pending = result(cwd, args, {
        environment: options?.env,
        signal: options?.signal,
        program: program === "node" ? process.execPath : program,
      });
      return {
        exitCode: pending.then(({ code }) => code),
        output: async () => ({ stdout: (await pending).stdout, stderr: "" }),
        async *logs() {},
        async kill() {},
      };
    },
  };
}

type EditCheckout = (checkout: string) => Promise<void>;
type FixtureEdits = { base: EditCheckout; left: EditCheckout; right: EditCheckout };

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
  edits?: FixtureEdits,
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
    await edits?.base(checkout);
    await git(checkout, ["add", "."]);
    await git(checkout, ["commit", "-qm", "base"]);
    const baseSha = await git(checkout, ["rev-parse", "HEAD"]);
    const retained = (runId: string, sha: string) =>
      "refs/heads/wallie/checkpoints/" + runId + "/" + sha;
    const parentRef = retained(parentRun, baseSha);
    async function branch(runId: string, message: string, edit: EditCheckout) {
      await git(checkout, ["checkout", "--detach", baseSha]);
      await edit(checkout);
      await git(checkout, ["add", "."]);
      await git(checkout, ["commit", "-qm", message]);
      const sha = await git(checkout, ["rev-parse", "HEAD"]);
      const ref = retained(runId, sha);
      await git(checkout, ["push", origin, "HEAD:" + ref]);
      return { sha, ref };
    }
    await git(checkout, ["push", origin, baseSha + ":refs/heads/main", baseSha + ":" + parentRef]);
    const left = await branch(
      leftRun,
      "left",
      edits?.left ?? ((dir) => writeFile(join(dir, "a file.txt"), "left\n")),
    );
    const right = await branch(
      rightRun,
      "right",
      edits?.right ?? ((dir) => writeFile(join(dir, "b file.txt"), "right\n")),
    );
    const conflict = await branch(rightRun, "conflict", (dir) =>
      writeFile(join(dir, "a file.txt"), "conflict\n"),
    );
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
            merge: (args, options) => runBoundedJoinMerge(localSandbox(cwd), args, options),
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

test("a directory rename split returns a truncated conflict with no file paths", async () =>
  fixture(
    async ({ origin, plan, integrate, leftSha, rightSha }) => {
      const mergeArgs = ["merge-tree", "--write-tree", "--name-only", "-z", leftSha, rightSha];
      const direct = await result(origin, mergeArgs);
      assert.equal(direct.code, 1);
      assert.equal(direct.stdout.split("\0")[1], "");
      assert.match(direct.stdout, /directory rename split/);

      const outcome = await integrate(plan, "directory-rename");
      assert.equal(outcome.kind, "conflict");
      assert.equal(outcome.edgeId, "branch.right");
      assert.deepEqual(outcome.paths, []);
      assert.equal(outcome.pathsTruncated, true);
    },
    {
      async base(checkout) {
        await mkdir(join(checkout, "previous"));
        await writeFile(join(checkout, "previous/b"), "first file\n");
        await writeFile(join(checkout, "previous/c"), "second file\n");
      },
      async left(checkout) {
        await mkdir(join(checkout, "one"));
        await mkdir(join(checkout, "two"));
        await git(checkout, ["mv", "previous/b", "one/b"]);
        await git(checkout, ["mv", "previous/c", "two/c"]);
      },
      async right(checkout) {
        await writeFile(join(checkout, "previous/d"), "new file with an ambiguous destination\n");
      },
    },
  ));

test("large real merge output retains only a bounded prefix and still produces a conflict", async () => {
  const directory = ["a".repeat(160), "b".repeat(160)].join("/");
  const paths = Array.from(
    { length: 1_000 },
    (_, index) => `${directory}/${String(index).padStart(4, "0")}-${"c".repeat(142)}.txt`,
  );
  const writeFixtures =
    (body: string): EditCheckout =>
    async (checkout) => {
      await mkdir(join(checkout, directory), { recursive: true });
      for (const path of paths) await writeFile(join(checkout, path), body);
    };
  await fixture(
    async ({ origin, plan, integrate, leftSha, rightSha }) => {
      const mergeArgs = ["merge-tree", "--write-tree", "--name-only", "-z", leftSha, rightSha];
      const direct = await result(origin, mergeArgs, { maxBuffer: 4 * 1024 * 1024 });
      assert.equal(direct.code, 1);
      assert.ok(Buffer.byteLength(direct.stdout) > 1024 * 1024);
      const bounded = await runBoundedJoinMerge(localSandbox(origin), mergeArgs, {
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(bounded.code, 1);
      assert.equal(bounded.truncated, true);
      assert.ok(Buffer.byteLength(bounded.stdout) <= 64 * 1024);
      assert.ok(bounded.stdout.endsWith("\0"));
      assert.ok(direct.stdout.startsWith(bounded.stdout));

      const outcome = await integrate(plan, "large-conflict");
      assert.equal(outcome.kind, "conflict");
      assert.equal(outcome.pathsTruncated, true);
      assert.ok(outcome.paths.length > 0);
      assert.deepEqual(outcome.paths, paths.slice(0, outcome.paths.length));
    },
    {
      base: writeFixtures("base\n"),
      left: writeFixtures("left\n"),
      right: writeFixtures("right\n"),
    },
  );
}, 20_000);

test("the bounded merge adapter preserves real Git errors", async () =>
  fixture(async ({ origin, rightSha }) => {
    for (const invalid of ["not-a-commit", "--wallie-nonexistent-option"]) {
      const args = ["merge-tree", "--write-tree", "--name-only", "-z", invalid, rightSha];
      const direct = await result(origin, args);
      assert.notEqual(direct.code, 0);
      const bounded = await runBoundedJoinMerge(localSandbox(origin), args, {
        signal: AbortSignal.timeout(15_000),
      });
      assert.deepEqual(bounded, { stdout: "", code: direct.code, truncated: false });
    }
  }));
