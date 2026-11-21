import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { replaySha256, type ReplayPlan } from "./replay-contracts";
import { stageBenchmarkReplay } from "./replay-sandbox";

const ref = "refs/heads/wallie/benchmark-fixtures/retained";
const id = (suffix: number) => "61400000-0000-4000-8000-" + String(suffix).padStart(12, "0");
const originalPrompt = "Keep the captured checkout and fixture data.";
const definitionJson = '{"fixture":"definition"}';
const contextManifestJson = '{"fixture":"context"}';

function replayPlan(sha: string): ReplayPlan {
  return {
    identity: {
      taskRevisionId: id(1),
      sourceRunId: id(2),
      sourceSessionId: id(11),
      sourceJobId: id(12),
      sourceAttemptCount: 1,
      repositoryId: id(13),
      definitionRevisionId: id(14),
      inputSha: sha,
      inputRef: ref,
      checkoutSha: sha,
      retryBundleSha256: null,
      definitionDigest: replaySha256(definitionJson),
      contextManifestSha256: replaySha256(contextManifestJson),
      originalPromptSha256: replaySha256(originalPrompt),
      renderedPromptSha256: replaySha256("Historical rendered prompt"),
      rendererVersion: 6,
    },
    runtime: {
      harness: "codex",
      model: "model-alias",
      worker: "node",
      runType: "code",
      stageId: id(3),
      sandboxProvider: "vercel",
      sandboxConnectionRevision: id(9),
      agentEffort: null,
      maxTurns: null,
    },
    text: {
      originalPrompt,
      definitionJson,
      contextManifestJson,
      required: [{ key: "session/prompt", body: originalPrompt }],
      documents: [{ revisionId: id(4), body: "Frozen document" }],
      memories: [{ revisionId: id(5), body: "Frozen memory" }],
      conversation: [{ sequence: 3, body: "Frozen conversation" }],
      skills: [{ revisionId: id(6), body: "Frozen skill" }],
      agentPrompt: { revisionId: id(7), body: "Frozen agent instructions" },
    },
    readRepositories: new Map(),
    retryBytes: null,
    limits: [
      "rendered_prompt_bytes_unavailable",
      "model_version_unverified",
      "runtime_version_unrecorded",
    ],
    candidateChanges: [],
  };
}

function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

async function retainedSource() {
  const directory = mkdtempSync(join(tmpdir(), "wallie-benchmark-origin-"));
  const repositoryUrl = join(directory, "origin.git");
  const original = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    git(directory, "init", "--bare", repositoryUrl);
    git(original.repoPath, "remote", "add", "origin", repositoryUrl);
    await original.writeFile(join(original.repoPath, "fixture.txt"), "Retained fixture");
    git(original.repoPath, "add", "fixture.txt");
    git(original.repoPath, "commit", "-m", "Retain benchmark fixture");
    const sha = git(original.repoPath, "rev-parse", "HEAD");
    const treeSha = git(original.repoPath, "rev-parse", "HEAD^{tree}");
    git(original.repoPath, "push", "origin", `HEAD:${ref}`);
    await original.writeFile(join(original.repoPath, "fixture.txt"), "Moving default");
    git(original.repoPath, "commit", "-am", "Change the default branch");
    const later = git(original.repoPath, "rev-parse", "HEAD");
    git(original.repoPath, "push", "origin", "HEAD:refs/heads/main");
    return { directory, repositoryUrl, sha, later, treeSha, originalPath: original.repoPath };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await original.stop();
  }
}

it("stages verified inputs in a fresh sandbox after teardown and leaves the remote and checkout clean", async () => {
  const { directory, originalPath, repositoryUrl, sha, later, treeSha } = await retainedSource();
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    expect(existsSync(originalPath)).toBe(false);
    rmSync(sandbox.repoPath, { recursive: true, force: true });
    expect(existsSync(sandbox.repoPath)).toBe(false);
    const plan = replayPlan(sha);
    const result = await stageBenchmarkReplay({
      sandbox,
      plan,
      provider: "fake",
      repositoryUrl,
      signal: AbortSignal.timeout(10_000),
    });
    try {
      expect(await sandbox.readFile(join(sandbox.repoPath, "fixture.txt"))).toBe(
        "Retained fixture",
      );
      expect(git(sandbox.repoPath, "status", "--porcelain")).toBe("");
      expect(git(repositoryUrl, "rev-parse", "refs/heads/main")).toBe(later);
      expect(git(repositoryUrl, "rev-parse", ref)).toBe(sha);
      expect(result.inputPath.startsWith(sandbox.repoPath)).toBe(false);
      expect(statSync(result.inputPath).mode & 0o777).toBe(0o600);
      const staged = await sandbox.readFile(result.inputPath);
      expect(staged).not.toBeNull();
      if (staged === null) throw new Error("The staged input file is missing.");
      expect(JSON.parse(staged)).toMatchObject({ text: plan.text });
      expect(result.receipt.restored).toMatchObject({
        checkoutSha: sha,
        treeSha,
        bundleSha256: replaySha256(staged),
      });
      expect(result.receipt.qualification.limits).toEqual([
        ...plan.limits,
        "sandbox_provider_changed",
        "sandbox_connection_changed",
      ]);
      const { receiptSha256, ...receipt } = result.receipt;
      expect(receiptSha256).toBe(replaySha256(JSON.stringify(receipt)));
      expect(JSON.stringify(receipt)).not.toContain(originalPrompt);
    } finally {
      await result.cleanup();
    }
    expect(existsSync(result.inputPath)).toBe(false);
  } finally {
    await sandbox.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["deleted", "moved", "tampered"] as const)(
  "rejects a %s replay input without using the new default branch",
  async (failure) => {
    const { directory, repositoryUrl, sha, later } = await retainedSource();
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const plan = replayPlan(sha);
      if (failure === "deleted") git(repositoryUrl, "update-ref", "-d", ref);
      if (failure === "moved") git(repositoryUrl, "update-ref", ref, later);
      if (failure === "tampered") plan.text.originalPrompt = "Changed task";
      await expect(
        stageBenchmarkReplay({
          sandbox,
          plan,
          provider: "fake",
          repositoryUrl,
          signal: AbortSignal.timeout(10_000),
        }),
      ).rejects.toThrow(
        failure === "tampered"
          ? /input failed its digest/
          : /starting source could not be restored/,
      );
      expect(existsSync(join(sandbox.repoPath, "fixture.txt"))).toBe(false);
      expect(git(repositoryUrl, "rev-parse", "refs/heads/main")).toBe(later);
    } finally {
      await sandbox.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("restores an exact private retry bundle after checking out its verified base", async () => {
  const { directory, repositoryUrl, sha } = await retainedSource();
  const producer = new FakeSandbox(undefined, { passthroughExec: true });
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    git(producer.repoPath, "fetch", repositoryUrl, ref);
    git(producer.repoPath, "checkout", "-B", "wallie-source-checkpoint", sha);
    await producer.writeFile(join(producer.repoPath, "fixture.txt"), "Retained retry");
    git(producer.repoPath, "commit", "-am", "Private retry work");
    const retrySha = git(producer.repoPath, "rev-parse", "HEAD");
    const bundlePath = join(directory, "retry.bundle");
    git(
      producer.repoPath,
      "bundle",
      "create",
      bundlePath,
      "refs/heads/wallie-source-checkpoint",
      `^${sha}`,
    );
    const retryBytes = readFileSync(bundlePath);
    await producer.stop();

    const plan = replayPlan(sha);
    plan.retryBytes = retryBytes;
    plan.identity.checkoutSha = retrySha;
    plan.identity.retryBundleSha256 = replaySha256(retryBytes);
    const result = await stageBenchmarkReplay({
      sandbox,
      plan,
      provider: "fake",
      repositoryUrl,
      signal: AbortSignal.timeout(10_000),
    });
    try {
      expect(result.receipt.restored.checkoutSha).toBe(retrySha);
      expect(await sandbox.readFile(join(sandbox.repoPath, "fixture.txt"))).toBe("Retained retry");
      expect(git(repositoryUrl, "rev-parse", ref)).toBe(sha);
    } finally {
      await result.cleanup();
    }
  } finally {
    await Promise.all([producer.stop(), sandbox.stop()]);
    rmSync(directory, { recursive: true, force: true });
  }
});
