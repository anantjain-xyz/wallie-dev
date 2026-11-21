import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import {
  createBenchmarkReplaySandbox,
  createUtilitySandbox,
  sealBenchmarkReplaySandbox,
  stopSandboxById,
} from "@/lib/sandbox";

import { FakeSandbox } from "@/lib/sandbox/fake";
import type { SandboxConnection } from "@/lib/sandbox/types";
import { createVercelQualifiedBenchmarkReplaySandbox } from "@/lib/sandbox/vercel";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
} from "@/lib/workspaces/resource-operations";

import { replaySha256, type ReplayPlan } from "./replay-contracts";
import { resolveBenchmarkReplay } from "./replay-inputs";
import { openBenchmarkReplayPolicy } from "./replay-policy";
import {
  stageBenchmarkReplay,
  withIsolatedBenchmarkReplay,
  withQualifiedBenchmarkReplay,
  withRestoredBenchmarkInputs,
} from "./replay-sandbox";

vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("./replay-inputs", () => ({ resolveBenchmarkReplay: vi.fn() }));
vi.mock("./replay-policy", () => ({ openBenchmarkReplayPolicy: vi.fn() }));
vi.mock(import("@/lib/sandbox"), async (importOriginal) => ({
  ...(await importOriginal()),
  createBenchmarkReplaySandbox: vi.fn(),
  createUtilitySandbox: vi.fn(),
  sealBenchmarkReplaySandbox: vi.fn(),
  stopSandboxById: vi.fn(),
}));
vi.mock(import("@/lib/sandbox/vercel"), async (importOriginal) => ({
  ...(await importOriginal()),
  createVercelQualifiedBenchmarkReplaySandbox: vi.fn(),
}));
vi.mock(import("@/lib/workspaces/resource-operations"), async (importOriginal) => ({
  ...(await importOriginal()),
  reserveWorkspaceSandbox: vi.fn(),
  recordWorkspaceSandbox: vi.fn(),
  settleWorkspaceResource: vi.fn(),
}));

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

async function acquiredReplay() {
  const { directory, repositoryUrl, sha } = await retainedSource();
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const plan = replayPlan(sha);
  const recheckAccess = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const controller = new AbortController();
  const admin = createClient<Database>("http://127.0.0.1:1", "local-test-key");
  const access: WorkspaceAccessContext = {
    supabase: admin,
    user: { id: id(18) },
    currentMember: { id: id(19), role: "owner", kind: "human", is_active: true },
    workspace: { id: id(20), slug: "replay-fixture", name: "Replay fixture", avatar_path: null },
  };
  const connection: SandboxConnection = {
    provider: "vercel",
    revision: id(9),
    credentials: { token: "fixture-token", teamId: "fixture-team", projectId: "fixture-project" },
  };
  const operationId = id(21);
  const run = sandbox.exec.bind(sandbox);
  const exec = vi
    .spyOn(sandbox, "exec")
    .mockImplementation((command, args, options) =>
      run(
        command,
        command === "git" && args[0] === "remote" && args[1] === "add"
          ? ["remote", "add", "origin", repositoryUrl]
          : args,
        options,
      ),
    );
  const stagedPaths: string[] = [];
  const write = sandbox.writeFile.bind(sandbox);
  const writeFile = vi
    .spyOn(sandbox, "writeFile")
    .mockImplementation(async (path, body, options) => {
      stagedPaths.push(path);
      await write(path, body, options);
    });
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
  vi.mocked(mintSandboxRepositoryToken).mockResolvedValue("fixture-read-token");
  vi.mocked(resolveBenchmarkReplay).mockResolvedValue({
    plan,
    baseBranch: "main",
    repository: {
      recordedInstallationId: id(22),
      installationId: 1,
      repositoryId: 2,
      repositoryFullName: "fixture/replay",
    },
    recheckAccess,
  });
  vi.mocked(reserveWorkspaceSandbox).mockClear().mockResolvedValue(operationId);
  vi.mocked(recordWorkspaceSandbox).mockClear().mockResolvedValue(true);
  vi.mocked(settleWorkspaceResource).mockClear().mockResolvedValue(undefined);
  vi.mocked(createUtilitySandbox).mockImplementation(async (request) => {
    await request.onSandboxCreated?.({ provider: "vercel", sandboxId: sandbox.id });
    return sandbox;
  });
  vi.mocked(createBenchmarkReplaySandbox)
    .mockClear()
    .mockImplementation(async (request) => {
      await request.onSandboxCreated?.({ provider: "vercel", sandboxId: sandbox.id });
      return sandbox;
    });
  vi.mocked(sealBenchmarkReplaySandbox).mockReset().mockResolvedValue(undefined);
  vi.mocked(openBenchmarkReplayPolicy).mockReset();
  vi.mocked(stopSandboxById)
    .mockClear()
    .mockImplementation(async (sandboxId) => {
      expect(sandboxId).toBe(sandbox.id);
      expect(stagedPaths.every((path) => !existsSync(path))).toBe(true);
      await sandbox.stop();
    });

  return {
    input: {
      access,
      connection,
      taskRevisionId: plan.identity.taskRevisionId,
      factoryId: id(23),
      signal: controller.signal,
    },
    admin,
    operationId,
    plan,
    controller,
    sandbox,
    recheckAccess,
    stagedPaths,
    exec,
    writeFile,
    async teardown() {
      await sandbox.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("removes staged inputs and settles the lease when an inspection ignores cancellation", async () => {
  const fixture = await acquiredReplay();
  const started = Promise.withResolvers<{ inputPath: string; signal: AbortSignal }>();
  const completion = Promise.withResolvers<string>();
  const reason = new Error("Cancel benchmark replay");
  try {
    const result = withRestoredBenchmarkInputs(fixture.input, ({ inputPath, signal }) => {
      started.resolve({ inputPath, signal });
      return completion.promise;
    });
    const rejected = expect(result).rejects.toBe(reason);
    const { inputPath, signal } = await started.promise;
    expect(existsSync(inputPath)).toBe(true);
    fixture.controller.abort(reason);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(existsSync(inputPath)).toBe(false);
    expect(existsSync(fixture.sandbox.repoPath)).toBe(false);
    expect(stopSandboxById).toHaveBeenCalledExactlyOnceWith(fixture.sandbox.id, {
      connection: fixture.input.connection,
      throwOnError: true,
    });
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
      fixture.admin,
      fixture.operationId,
      true,
    );
  } finally {
    completion.resolve("Late inspection success");
    await fixture.teardown();
  }
});

it.each(["firewall", "policy"] as const)(
  "tears down the sandbox without running a candidate when %s verification fails",
  async (barrier) => {
    const fixture = await acquiredReplay();
    const failure = new Error("Replay isolation unavailable");
    const execute = vi.fn<() => Promise<void>>();
    if (barrier === "firewall") {
      vi.mocked(sealBenchmarkReplaySandbox).mockRejectedValueOnce(failure);
    } else {
      vi.mocked(openBenchmarkReplayPolicy).mockRejectedValueOnce(failure);
    }
    try {
      await expect(
        withIsolatedBenchmarkReplay(
          {
            ...fixture.input,
            executionId: id(30),
            policyRevisionId: id(31),
            expectedPolicyDigest: replaySha256("approved replay profile"),
          },
          execute,
        ),
      ).rejects.toBe(failure);
      expect(execute).not.toHaveBeenCalled();
      expect(createBenchmarkReplaySandbox).toHaveBeenCalledOnce();
      expect(sealBenchmarkReplaySandbox).toHaveBeenCalledOnce();
      expect(openBenchmarkReplayPolicy).toHaveBeenCalledTimes(barrier === "firewall" ? 0 : 1);
      expect(stopSandboxById).toHaveBeenCalledOnce();
      expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
        fixture.admin,
        fixture.operationId,
        true,
      );
    } finally {
      await fixture.teardown();
    }
  },
);

it("reports the qualified firewall phase before a seal rejection and still cleans up", async () => {
  const fixture = await acquiredReplay();
  const failure = new Error("Synthetic seal failure");
  const phases: string[] = [];
  const execute = vi.fn<() => Promise<void>>();
  vi.mocked(createVercelQualifiedBenchmarkReplaySandbox).mockImplementationOnce(async (request) => {
    await request.onSandboxCreated({ provider: "vercel", sandboxId: fixture.sandbox.id });
    return Object.assign(fixture.sandbox, {
      async sealBenchmarkInference() {
        expect(phases.at(-1)).toBe("sealing_network");
        throw failure;
      },
    });
  });
  try {
    await expect(
      withQualifiedBenchmarkReplay(
        {
          ...fixture.input,
          executionId: id(30),
          policyRevisionId: id(31),
          expectedPolicyDigest: replaySha256("blocked replay profile"),
          profile: {
            image: `vcr.vercel.com/fixture/sandbox@sha256:${"a".repeat(64)}`,
            proxyUrl: "https://replay.example.test/api/internal/benchmark-openai",
          },
          onSetupPhase: (phase) => phases.push(phase),
        },
        execute,
      ),
    ).rejects.toBe(failure);
    expect(phases).toEqual(["acquiring_sandbox", "restoring_inputs", "sealing_network"]);
    expect(openBenchmarkReplayPolicy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
      fixture.admin,
      fixture.operationId,
      true,
    );
  } finally {
    await fixture.teardown();
  }
});

it("runs only after isolation and exposes approved context separately from snapshot evidence", async () => {
  const fixture = await acquiredReplay();
  const endpoint = "https://unapproved-provider.invalid/mcp";
  const historicalKey = "synthetic-historical-credential";
  const policyRevisionId = id(31);
  const executionId = id(30);
  const expectedPolicyDigest = replaySha256("approved replay profile");
  fixture.plan.text.definitionJson = JSON.stringify({ endpoint, historicalKey });
  fixture.plan.identity.definitionDigest = replaySha256(fixture.plan.text.definitionJson);
  fixture.plan.text.contextManifestJson = JSON.stringify({ endpoint });
  fixture.plan.identity.contextManifestSha256 = replaySha256(fixture.plan.text.contextManifestJson);
  fixture.plan.runtime.model = endpoint;
  const events: string[] = [];
  vi.mocked(sealBenchmarkReplaySandbox).mockImplementation(async () => {
    events.push("sealed");
  });
  vi.mocked(openBenchmarkReplayPolicy).mockImplementation(async (input) => {
    events.push("pinned");
    return {
      permit: {
        version: 1,
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        factoryId: input.factoryId,
        taskRevisionId: input.taskRevisionId,
        policyRevisionId: input.policyRevisionId,
        policyDigest: input.expectedPolicyDigest,
        restorationReceiptSha256: input.restorationReceiptSha256,
        profile: "recorded_fixtures",
      },
      invoke: vi.fn(),
    };
  });
  try {
    const snapshot = await withIsolatedBenchmarkReplay(
      { ...fixture.input, executionId, policyRevisionId, expectedPolicyDigest },
      async ({ sandbox, broker, inputPath, snapshot }) => {
        events.push("executed");
        expect(sandbox).not.toHaveProperty("stop");
        expect(git(sandbox.repoPath, "remote")).toBe("");
        const staged = await sandbox.readFile(inputPath);
        if (staged === null) throw new Error("The staged replay context is missing.");
        expect(staged).not.toContain(endpoint);
        expect(staged).not.toContain(historicalKey);
        expect(JSON.parse(staged)).toMatchObject({
          version: 1,
          text: {
            originalPrompt,
            documents: fixture.plan.text.documents,
            skills: fixture.plan.text.skills,
          },
        });
        expect(snapshot.inputBundleSha256).toBe(replaySha256(staged));
        expect(broker.permit).toMatchObject({
          executionId,
          policyRevisionId,
          restorationReceiptSha256: snapshot.restorationReceiptSha256,
        });
        return snapshot;
      },
    );
    expect(events).toEqual(["sealed", "pinned", "executed"]);
    expect(mintSandboxRepositoryToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ purpose: "benchmark-checkout", repositoryId: 2 }),
    );
    const exported = JSON.stringify(snapshot);
    expect(exported).not.toContain(endpoint);
    expect(exported).not.toContain(historicalKey);
    expect(exported).not.toContain(originalPrompt);
    expect(exported).not.toContain("Frozen document");
    expect(existsSync(fixture.sandbox.repoPath)).toBe(false);
  } finally {
    await fixture.teardown();
  }
});

it("stops the sandbox when a provider write stays pending after cancellation", async () => {
  const fixture = await acquiredReplay();
  const writing = Promise.withResolvers<void>();
  const writeFinished = Promise.withResolvers<void>();
  const reason = new Error("Cancel while staging");
  const inspect = vi.fn<() => Promise<void>>();
  let scratch: string | undefined;
  fixture.writeFile.mockImplementationOnce((path) => {
    scratch = dirname(path);
    writing.resolve();
    return writeFinished.promise;
  });
  try {
    const result = withRestoredBenchmarkInputs(fixture.input, inspect);
    const rejected = expect(result).rejects.toBe(reason);
    await writing.promise;
    fixture.controller.abort(reason);
    await rejected;
    expect(existsSync(fixture.sandbox.repoPath)).toBe(false);
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
      fixture.admin,
      fixture.operationId,
      true,
    );
    writeFinished.resolve();
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();
    expect(fixture.exec.mock.calls.some(([command]) => command === "sha256sum")).toBe(false);
  } finally {
    writeFinished.resolve();
    await fixture.teardown();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

it("does not return an inspection result if cancellation arrives during teardown", async () => {
  const fixture = await acquiredReplay();
  const reason = new Error("Cancel during sandbox stop");
  const stopping = Promise.withResolvers<void>();
  const finishStop = Promise.withResolvers<void>();
  vi.mocked(stopSandboxById).mockImplementationOnce(async () => {
    stopping.resolve();
    await finishStop.promise;
    await fixture.sandbox.stop();
  });
  try {
    const result = withRestoredBenchmarkInputs(fixture.input, async () => "Inspection finished");
    const rejected = expect(result).rejects.toBe(reason);
    await stopping.promise;
    fixture.controller.abort(reason);
    finishStop.resolve();
    await rejected;
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
      fixture.admin,
      fixture.operationId,
      true,
    );
  } finally {
    finishStop.resolve();
    await fixture.teardown();
  }
});

it("discards a staged bundle if source access is revoked before inspection", async () => {
  const fixture = await acquiredReplay();
  const revoked = new Error("Original context access revoked");
  fixture.recheckAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);
  const inspect = vi.fn<() => Promise<void>>();
  try {
    await expect(withRestoredBenchmarkInputs(fixture.input, inspect)).rejects.toBe(revoked);
    expect(fixture.stagedPaths).toHaveLength(1);
    expect(existsSync(fixture.stagedPaths[0])).toBe(false);
    expect(existsSync(fixture.sandbox.repoPath)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
      fixture.admin,
      fixture.operationId,
      true,
    );
  } finally {
    await fixture.teardown();
  }
});

it.each([false, true])(
  "cleans up or retains its obligation after a failed checkout (stop fails: %s)",
  async (stopFails) => {
    const fixture = await acquiredReplay();
    const stopError = new Error("Provider could not confirm stop");
    if (stopFails) vi.mocked(stopSandboxById).mockRejectedValueOnce(stopError);
    fixture.plan.identity.inputRef = "refs/heads/wallie/missing-fixture";
    const inspect = vi.fn<() => Promise<void>>();
    try {
      await expect(withRestoredBenchmarkInputs(fixture.input, inspect)).rejects.toThrow(
        stopFails ? stopError.message : "The exact starting source could not be restored.",
      );
      expect(inspect).not.toHaveBeenCalled();
      expect(stopSandboxById).toHaveBeenCalledExactlyOnceWith(fixture.sandbox.id, {
        connection: fixture.input.connection,
        throwOnError: true,
      });
      expect(existsSync(fixture.sandbox.repoPath)).toBe(stopFails);
      expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(
        fixture.admin,
        fixture.operationId,
        !stopFails,
      );
    } finally {
      await fixture.teardown();
    }
  },
);
