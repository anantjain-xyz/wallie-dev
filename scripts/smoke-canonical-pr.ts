/**
 * Live, isolated GitHub acceptance smoke. Preview performs no authentication or writes.
 *
 * node --import ./scripts/register-server-only.mjs --import tsx \
 *   scripts/smoke-canonical-pr.ts --repository owner/wallie-pr-sync-smoke-YYYYMMDD
 * Add --execute only after reviewing the plan and selecting a private, empty fixture.
 * The fixture repository, retained refs, and pull requests are intentionally preserved.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CanonicalRefConflictError,
  promoteCanonicalRefsWithWorkspace,
  type CanonicalPromotionInput,
} from "../src/lib/pipeline/canonical-pr-git";
import type { GitExecutor } from "../src/lib/pipeline/source-delivery-git-core";

const exec = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA = /^[a-f0-9]{40}$/;
let phase = "arguments";
let fixtureRepository: string | undefined;

class SmokeFailure extends Error {}

function argumentsForSmoke() {
  let repository: string | undefined;
  let execute = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") return { help: true, execute: false, repository: undefined };
    if (arg === "--execute" && !execute) execute = true;
    else if (arg === "--repository" && !repository) repository = args[++index];
    else throw new SmokeFailure("invalid-arguments");
  }
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new SmokeFailure("repository-owner-name-required");
  const name = repository.split("/")[1];
  if (!/(?:^|[-_.])(?:smoke|test)(?:[-_.]|$)/i.test(name))
    throw new SmokeFailure("repository-name-must-identify-smoke-or-test-fixture");
  return { help: false, execute, repository };
}

function fenceSha(operationId: string, parent: string | null) {
  const body =
    `tree ${EMPTY_TREE}\n` +
    (parent ? `parent ${parent}\n` : "") +
    "author Wallie <noreply@wallie.dev> 946684800 +0000\n" +
    "committer Wallie <noreply@wallie.dev> 946684800 +0000\n\n" +
    `Wallie canonical publication ${operationId}\n`;
  return createHash("sha1")
    .update(`commit ${Buffer.byteLength(body)}\0${body}`)
    .digest("hex");
}

async function main() {
  const options = argumentsForSmoke();
  if (options.help) {
    console.log(
      "Usage: node --import ./scripts/register-server-only.mjs --import tsx scripts/smoke-canonical-pr.ts --repository owner/private-smoke-repository [--execute]",
    );
    return;
  }
  const repository = options.repository!;
  fixtureRepository = repository;
  if (!options.execute) {
    console.log(
      JSON.stringify({
        status: "preview",
        repository,
        requires: "An empty, private GitHub smoke/test repository with push permission.",
        writes: [
          "Create main and three immutable retained source refs in the empty fixture.",
          "Atomically publish two revisions to one canonical branch and one PR.",
          "Replay a completed operation and recover its existing PR without another push or POST.",
          "Push an external fixture commit and verify the stale operation preserves it.",
          "Close the first PR and observe terminal state without another promotion.",
          "Explicitly publish a distinct epoch branch and second PR.",
        ],
        cleanup: "Remove local temporary files; preserve repository, refs and PR history.",
        execute: "Add --execute after reviewing this plan.",
      }),
    );
    return;
  }

  phase = "authentication";
  // Capture credentials internally. They never enter command arguments or output.
  const { stdout } = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  const token = stdout.trim();
  if (!token) throw new SmokeFailure("github-authentication-unavailable");
  const signal = AbortSignal.timeout(300_000);
  const github = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wallie-canonical-pr-smoke",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new SmokeFailure(`github-request-${response.status}`);
    return (await response.json()) as T;
  };

  phase = "fixture-validation";
  const metadata = await github<{
    id: number;
    full_name: string;
    private: boolean;
    archived: boolean;
    disabled: boolean;
    fork: boolean;
    permissions?: { push?: boolean };
  }>("");
  if (
    !Number.isSafeInteger(metadata.id) ||
    metadata.full_name.toLowerCase() !== repository.toLowerCase() ||
    !metadata.private ||
    metadata.archived ||
    metadata.disabled ||
    metadata.fork ||
    !metadata.permissions?.push
  )
    throw new SmokeFailure("fixture-must-be-private-owned-writable-and-active");
  const existingBranches = await github<unknown[]>("/branches?per_page=1");
  if (!Array.isArray(existingBranches) || existingBranches.length !== 0)
    throw new SmokeFailure("fixture-must-be-empty-before-any-write");

  const { createCanonicalPrApi } = await import("../src/lib/pipeline/canonical-pr-api");
  const root = await mkdtemp(join(tmpdir(), "wallie-canonical-pr-smoke-"));
  let summary: Record<string, unknown> | undefined;
  try {
    phase = "local-source-fixture";
    const source = join(root, "source");
    await mkdir(source);
    const remoteUrl = `https://github.com/${repository}.git`;
    const gitEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_AUTHOR_NAME: "Wallie",
      GIT_AUTHOR_EMAIL: "noreply@wallie.dev",
      GIT_AUTHOR_DATE: "946684800 +0000",
      GIT_COMMITTER_NAME: "Wallie",
      GIT_COMMITTER_EMAIL: "noreply@wallie.dev",
      GIT_COMMITTER_DATE: "946684800 +0000",
    };
    const git = async (args: string[]) => {
      signal.throwIfAborted();
      const result = await exec("git", args, {
        cwd: source,
        env: gitEnv,
        signal,
        maxBuffer: 1024 * 1024,
        timeout: 45_000,
      });
      signal.throwIfAborted();
      return result.stdout.trim();
    };
    await git(["init", "--quiet", "--initial-branch=main"]);
    await writeFile(
      join(source, "README.md"),
      "# Wallie canonical PR smoke\n\nDisposable acceptance fixture.\n",
    );
    await writeFile(join(source, "source.txt"), "Base source\n");
    await git(["add", "README.md", "source.txt"]);
    await git(["commit", "-qm", "Smoke base"]);
    const baseSha = await git(["rev-parse", "HEAD"]);
    const sourceRevision = async (contents: string, message: string) => {
      await writeFile(join(source, "source.txt"), contents);
      await git(["add", "source.txt"]);
      await git(["commit", "-qm", message]);
      return git(["rev-parse", "HEAD"]);
    };
    const firstSha = await sourceRevision("Revision one\n", "Smoke revision one");
    const secondSha = await sourceRevision("Revision two\n", "Smoke revision two");
    const externalSha = await sourceRevision("External smoke writer\n", "Smoke external writer");
    for (const sha of [baseSha, firstSha, secondSha, externalSha]) assert.match(sha, SHA);
    const retained = [firstSha, secondSha, externalSha].map((sha) => ({
      sha,
      ref: `refs/heads/wallie/checkpoints/${randomUUID()}/${sha}`,
    }));
    phase = "push-isolated-fixture-refs";
    await git([
      "push",
      "--atomic",
      "--force-with-lease=refs/heads/main:",
      ...retained.map(({ ref }) => `--force-with-lease=${ref}:`),
      remoteUrl,
      `${baseSha}:refs/heads/main`,
      ...retained.map(({ ref, sha }) => `${sha}:${ref}`),
    ]);

    let promotionPushes = 0;
    const dependencies = {
      execGit: (async (args, gitOptions) => {
        if (args[0] === "push") promotionPushes++;
        return exec("git", args, { ...gitOptions, encoding: "utf8" });
      }) satisfies GitExecutor,
      createWorkspace: async () => {
        const path = await mkdtemp(join(root, "promotion-"));
        return {
          path,
          writeBundle: async (bytes: Buffer) => writeFile(join(path, "source.bundle"), bytes),
          close: () => rm(path, { recursive: true, force: true }),
        };
      },
    };
    const sessionId = randomUUID();
    const epochId = randomUUID();
    const branchName = `wallie/sessions/${sessionId}/${epochId}`;
    const fenceRef = `refs/heads/wallie/session-fences/${epochId}`;
    const apiFor = (branch: string) =>
      createCanonicalPrApi({
        repositoryFullName: repository,
        repositoryNumericId: metadata.id,
        branchName: branch,
        baseBranch: "main",
        token,
        signal,
      });
    const api = apiFor(branchName);
    const operationInput = (
      desiredSha: string,
      sourceRef: string,
      expected: { headSha: string; fenceSha: string } | null,
      branch = branchName,
      fence = fenceRef,
    ): CanonicalPromotionInput => {
      const operationId = randomUUID();
      return {
        operationId,
        desiredSha,
        sourceRef,
        branchName: branch,
        fenceRef: fence,
        expectedHeadSha: expected?.headSha ?? null,
        expectedFenceSha: expected?.fenceSha ?? null,
        desiredFenceSha: fenceSha(operationId, expected?.fenceSha ?? null),
        remoteUrl,
        token,
        signal,
      };
    };
    const remotePair = async (branch = branchName, fence = fenceRef) => {
      const headRef = `refs/heads/${branch}`;
      const output = await git(["ls-remote", "--refs", remoteUrl, headRef, fence]);
      const refs = output.split("\n").map((line) => line.split(/\s+/));
      return {
        headSha: refs.find(([, ref]) => ref === headRef)?.[0] ?? null,
        fenceSha: refs.find(([, ref]) => ref === fence)?.[0] ?? null,
      };
    };
    const pullRequestsFor = (branch: string) =>
      github<Array<{ number: number }>>(
        `/pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${branch}`)}&per_page=100`,
      );
    const waitForHead = async (number: number, sha: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const pull = await api.get(number);
        if (pull.headSha === sha) return pull;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new SmokeFailure("github-pr-head-did-not-converge");
    };

    phase = "first-canonical-revision";
    assert.equal(await api.find(), null);
    const firstOperation = operationInput(firstSha, retained[0].ref, null);
    const firstPair = await promoteCanonicalRefsWithWorkspace(firstOperation, dependencies);
    const firstPr = await api.create({
      title: "Wallie canonical PR smoke: original epoch",
      body: `Disposable OP-498 acceptance fixture.\n\nSession: ${sessionId}\nEpoch: ${epochId}`,
    });
    assert.equal(firstPr.state, "open");
    assert.equal((await waitForHead(firstPr.number, firstSha)).number, firstPr.number);
    assert.equal((await api.find())?.number, firstPr.number);

    phase = "second-revision-same-pull-request";
    const secondOperation = operationInput(secondSha, retained[1].ref, firstPair);
    secondOperation.beforePush = async () => {
      assert.equal((await api.get(firstPr.number)).state, "open");
    };
    const secondPair = await promoteCanonicalRefsWithWorkspace(secondOperation, dependencies);
    assert.equal((await waitForHead(firstPr.number, secondSha)).number, firstPr.number);
    assert.equal((await api.find())?.number, firstPr.number);
    assert.equal((await pullRequestsFor(branchName)).length, 1);

    phase = "lost-receipt-reconciliation";
    // Simulate a remote success followed by loss of the durable acknowledgement.
    // Replay the SAME immutable operation rather than manufacturing a new fence.
    const pushesBeforeReplay = promotionPushes;
    const replay = await promoteCanonicalRefsWithWorkspace(secondOperation, dependencies);
    assert.deepEqual(replay, secondPair);
    assert.equal(promotionPushes, pushesBeforeReplay);
    assert.equal((await api.find())?.number, firstPr.number);
    assert.equal((await pullRequestsFor(branchName)).length, 1);

    phase = "external-head-conflict";
    await git([
      "push",
      `--force-with-lease=refs/heads/${branchName}:${secondSha}`,
      remoteUrl,
      `${externalSha}:refs/heads/${branchName}`,
    ]);
    const staleOperation = operationInput(firstSha, retained[0].ref, secondPair);
    const pushesBeforeConflict = promotionPushes;
    await assert.rejects(
      promoteCanonicalRefsWithWorkspace(staleOperation, dependencies),
      CanonicalRefConflictError,
    );
    assert.equal(promotionPushes, pushesBeforeConflict);
    const externalPair = { headSha: externalSha, fenceSha: secondPair.fenceSha };
    assert.deepEqual(await remotePair(), externalPair);
    await waitForHead(firstPr.number, externalSha);

    phase = "terminal-pull-request-observation";
    await github(`/pulls/${firstPr.number}`, "PATCH", { state: "closed" });
    const terminal = await api.get(firstPr.number);
    assert.equal(terminal.state, "closed");
    assert.equal(terminal.number, firstPr.number);
    let terminalPromotionCalls = 0;
    // Match the publisher's pinned-PR terminal guard: observe and stop before Git.
    const isOpen = (pull: { state: string }) => pull.state === "open";
    if (isOpen(terminal)) {
      terminalPromotionCalls++;
      await promoteCanonicalRefsWithWorkspace(staleOperation, dependencies);
    }
    assert.equal(terminalPromotionCalls, 0);
    assert.equal(promotionPushes, pushesBeforeConflict);
    assert.deepEqual(await remotePair(), externalPair);
    assert.equal((await pullRequestsFor(branchName)).length, 1);

    phase = "explicit-successor-epoch";
    const successorEpoch = randomUUID();
    const successorBranch = `wallie/sessions/${sessionId}/${successorEpoch}`;
    const successorFence = `refs/heads/wallie/session-fences/${successorEpoch}`;
    const successorApi = apiFor(successorBranch);
    assert.equal(await successorApi.find(), null);
    const successorOperation = operationInput(
      secondSha,
      retained[1].ref,
      null,
      successorBranch,
      successorFence,
    );
    const successorPair = await promoteCanonicalRefsWithWorkspace(successorOperation, dependencies);
    const successorPr = await successorApi.create({
      title: "Wallie canonical PR smoke: explicit successor epoch",
      body: `Explicit successor of fixture PR #${firstPr.number}.\n\nSession: ${sessionId}\nEpoch: ${successorEpoch}`,
    });
    assert.notEqual(successorPr.number, firstPr.number);
    assert.equal(successorPr.state, "open");
    assert.equal((await successorApi.find())?.number, successorPr.number);
    assert.equal((await api.get(firstPr.number)).state, "closed");
    assert.deepEqual(await remotePair(successorBranch, successorFence), successorPair);
    assert.deepEqual(await remotePair(), externalPair);
    assert.equal((await pullRequestsFor(successorBranch)).length, 1);

    summary = {
      status: "passed",
      repository,
      repositoryId: metadata.id,
      repositoryUrl: `https://github.com/${repository}`,
      orchestration: "Manual immutable-operation replay; no application database or deployment.",
      sessionId,
      original: {
        epochId,
        branch: branchName,
        prNumber: firstPr.number,
        prUrl: firstPr.url,
        prState: terminal.state,
        isDraft: terminal.draft,
        firstPair,
        secondPair,
        finalPair: externalPair,
      },
      successor: {
        epochId: successorEpoch,
        branch: successorBranch,
        prNumber: successorPr.number,
        prUrl: successorPr.url,
        prState: successorPr.state,
        isDraft: successorPr.draft,
        pair: successorPair,
      },
      retained,
      promotionPushes,
      invariants: {
        twoRevisionsOnePullRequest: true,
        lostReceiptReplayedWithoutPushOrDuplicatePr: true,
        externalHeadPreserved: true,
        terminalPinnedPrObservedWithoutPromotion: true,
        explicitSuccessorHasDistinctBranchAndPr: true,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  phase = "completed";
  console.log(
    JSON.stringify({ ...summary, localTemporaryFiles: "removed", fixtureHistory: "preserved" }),
  );
}

void main().catch((error: unknown) => {
  // Never print raw process/fetch errors: they can contain credentials or headers.
  console.error(
    JSON.stringify({
      status: "failed",
      repository: fixtureRepository,
      phase,
      error: error instanceof SmokeFailure ? error.message : "canonical-pr-smoke-failed",
      fixtureHistory: "preserved; inspect the fixture before deciding how to resume",
    }),
  );
  process.exitCode = 1;
});
