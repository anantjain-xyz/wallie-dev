import "server-only";

import { randomUUID } from "node:crypto";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import {
  materializeFactoryRepositoryContext,
  type FactoryRepositoryContextSnapshot,
} from "@/lib/pipeline/repository-context";
import { restoreRetryCheckpoint } from "@/lib/pipeline/retry-checkpoint-git";
import {
  createBenchmarkReplaySandbox,
  createUtilitySandbox,
  sealBenchmarkReplaySandbox,
  stopSandboxById,
} from "@/lib/sandbox";
import { checkoutSandboxCheckpoint } from "@/lib/sandbox/checkout";
import { observeUntilAbort, runBoundedSandboxProviderOperation } from "@/lib/sandbox/lifecycle";
import type {
  CreateUtilitySandboxInput,
  SandboxConnection,
  SandboxExecOptions,
  SandboxHandle,
} from "@/lib/sandbox/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
  WorkspaceDeletingError,
} from "@/lib/workspaces/resource-operations";

import {
  BenchmarkReplayUnavailable,
  replayCommitSchema,
  replaySha256,
  type ReplayPlan,
} from "./replay-contracts";
import { resolveBenchmarkReplay } from "./replay-inputs";
import { openBenchmarkReplayPolicy, type BenchmarkReplayBroker } from "./replay-policy";

const lifetimeMs = 180_000;
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.followRedirects",
  GIT_CONFIG_VALUE_0: "false",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};

async function runRestoreCommand(
  sandbox: SandboxHandle,
  cmd: string,
  args: string[],
  signal: AbortSignal,
  cwd = sandbox.repoPath,
) {
  signal.throwIfAborted();
  const process = await sandbox.exec(cmd, args, {
    cwd,
    signal,
    ...(cmd === "git" ? { env: gitEnvironment } : {}),
  });
  const [code, output] = await Promise.all([process.exitCode, process.output()]);
  signal.throwIfAborted();
  if (code !== 0)
    throw new BenchmarkReplayUnavailable("The replay sandbox could not restore its inputs.");
  return output.stdout.trim();
}

/** Verify source and stage inputs without launching repository code or an agent. */
export async function stageBenchmarkReplay(input: {
  sandbox: SandboxHandle;
  provider: SandboxConnection["provider"] | "fake";
  connectionRevision?: string;
  repositoryUrl: string;
  token?: string;
  plan: ReplayPlan;
  readContext?: readonly Pick<FactoryRepositoryContextSnapshot, "repositoryId" | "commitSha">[];
  payloadKind?: "isolated_context" | "qualified_task";
  signal: AbortSignal;
}) {
  const { sandbox, provider, connectionRevision, repositoryUrl, token, plan, signal } = input;
  const { identity, text, retryBytes } = plan;
  const repositories = new Map(
    (input.readContext ?? []).map((row) => [row.repositoryId, row.commitSha]),
  );
  if (
    repositories.size !== (input.readContext?.length ?? 0) ||
    repositories.size !== plan.readRepositories.size ||
    [...plan.readRepositories].some(([id, sha]) => repositories.get(id) !== sha)
  ) {
    throw new BenchmarkReplayUnavailable(
      "The restored repository context does not match the captured commits.",
    );
  }
  if (
    replaySha256(text.originalPrompt) !== identity.originalPromptSha256 ||
    replaySha256(text.definitionJson) !== identity.definitionDigest ||
    replaySha256(text.contextManifestJson) !== identity.contextManifestSha256 ||
    (retryBytes === null ? null : replaySha256(retryBytes)) !== identity.retryBundleSha256
  ) {
    throw new BenchmarkReplayUnavailable("A replay input failed its digest check.");
  }
  if (!retryBytes && identity.inputSha !== identity.checkoutSha)
    throw new BenchmarkReplayUnavailable(
      "The original retry source is required for this checkout.",
    );
  signal.throwIfAborted();

  const instance = randomUUID();
  const directory = `/tmp/wallie-benchmark-replay-${instance}`;
  const inputPath = `${directory}/inputs.json`;
  const branch = `wallie/benchmark-replay/${instance}`;
  const cleanup = () => {
    const deadline = AbortSignal.timeout(5_000);
    return observeUntilAbort(deadline, () =>
      runRestoreCommand(sandbox, "rm", ["-rf", directory], deadline, "/tmp"),
    );
  };
  let complete = false;
  try {
    // An ephemeral command environment keeps installation credentials off disk.
    await runRestoreCommand(sandbox, "mkdir", ["-p", "--", sandbox.repoPath], signal, "/tmp");
    await runRestoreCommand(sandbox, "git", ["init", "--quiet", "--template="], signal);
    await runRestoreCommand(sandbox, "git", ["remote", "add", "origin", repositoryUrl], signal);
    await checkoutSandboxCheckpoint({
      sandbox,
      branch,
      signal,
      checkpoint: {
        sha: identity.inputSha,
        ...(identity.inputRef ? { ref: identity.inputRef } : {}),
      },
      gitEnvironment: token
        ? {
            ...gitEnvironment,
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_1: `http.${repositoryUrl}.extraheader`,
            GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }
        : gitEnvironment,
    });
    if (retryBytes && identity.retryBundleSha256) {
      await restoreRetryCheckpoint({
        sandbox,
        signal,
        bytes: retryBytes,
        sha256: identity.retryBundleSha256,
        baseSha: identity.inputSha,
        headSha: identity.checkoutSha,
      });
    }
    const [checkoutSha, treeSha] = (
      await runRestoreCommand(sandbox, "git", ["rev-parse", "HEAD", "HEAD^{tree}"], signal)
    ).split("\n");
    const dirty = await runRestoreCommand(sandbox, "git", ["status", "--porcelain"], signal);
    if (
      checkoutSha !== identity.checkoutSha ||
      !replayCommitSchema.safeParse(treeSha).success ||
      dirty
    )
      throw new BenchmarkReplayUnavailable(
        "The restored checkout does not match the recorded clean source.",
      );

    if (input.payloadKind) {
      await runRestoreCommand(sandbox, "git", ["remote", "remove", "origin"], signal);
    }
    const readRepositories = [...plan.readRepositories].map(([id, commitSha]) => ({
      id,
      commitSha,
    }));
    const task = {
      originalPrompt: text.originalPrompt,
      required: text.required,
      documents: text.documents,
      memories: text.memories,
      conversation: text.conversation,
    };
    let payload: string;
    switch (input.payloadKind) {
      case "qualified_task":
        payload = JSON.stringify({ version: 1, readRepositories, text: task });
        break;
      case "isolated_context":
        payload = JSON.stringify({
          version: 1,
          text: { ...task, skills: text.skills, agentPrompt: text.agentPrompt },
        });
        break;
      default:
        payload = JSON.stringify({
          version: 1,
          identity,
          runtime: plan.runtime,
          readRepositories,
          text,
        });
    }
    const bundleSha256 = replaySha256(payload);
    await runRestoreCommand(sandbox, "mkdir", ["-m", "700", directory], signal);
    signal.throwIfAborted();
    await sandbox.writeFile(inputPath, payload, { mode: 0o600 });
    signal.throwIfAborted();
    const [observedDigest] = (
      await runRestoreCommand(sandbox, "sha256sum", [inputPath], signal)
    ).split(/\s+/, 1);
    if (observedDigest !== bundleSha256)
      throw new BenchmarkReplayUnavailable(
        "The restored private input bundle failed its digest check.",
      );

    const limits = [...plan.limits];
    if (plan.runtime.sandboxProvider && plan.runtime.sandboxProvider !== provider) {
      limits.push("sandbox_provider_changed");
    }
    if (
      plan.runtime.sandboxConnectionRevision &&
      plan.runtime.sandboxConnectionRevision !== connectionRevision
    ) {
      limits.push("sandbox_connection_changed");
    }
    const rawNodeVersion = await runRestoreCommand(sandbox, "node", ["--version"], signal).catch(
      () => null,
    );
    const runtimeNodeVersion = /^v[0-9]+[.][0-9]+[.][0-9]+$/.test(rawNodeVersion ?? "")
      ? rawNodeVersion
      : null;
    signal.throwIfAborted();
    const receipt = {
      version: 1 as const,
      identity,
      runtime: plan.runtime,
      restored: {
        provider,
        connectionRevision: connectionRevision ?? null,
        runtimeNodeVersion,
        checkoutSha,
        treeSha,
        bundleSha256,
        ...(input.payloadKind ? { bundleKind: input.payloadKind } : {}),
        readRepositories,
      },
      qualification: { limits, candidateChanges: plan.candidateChanges },
    };
    complete = true;
    return {
      inputPath,
      receipt: { ...receipt, receiptSha256: replaySha256(JSON.stringify(receipt)) },
      cleanup,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BenchmarkReplayUnavailable) throw error;
    throw new BenchmarkReplayUnavailable("The exact starting source could not be restored.");
  } finally {
    if (!complete) await cleanup().catch(() => undefined);
  }
}

export async function withRestoredBenchmarkInputs<T>(
  input: BenchmarkSandboxInput,
  inspect: (result: RestoredBenchmarkInputs) => Promise<T>,
) {
  return withBenchmarkSandbox(input, "restore", inspect);
}

type BenchmarkSandboxInput = Parameters<typeof resolveBenchmarkReplay>[0] & {
  connection: SandboxConnection;
  onSandboxCreated?: CreateUtilitySandboxInput["onSandboxCreated"];
};

type StagedReplay = Awaited<ReturnType<typeof stageBenchmarkReplay>>;
type RestoredBenchmarkInputs = Omit<StagedReplay, "cleanup"> & {
  sandbox: SandboxHandle;
  signal: AbortSignal;
  readContext: FactoryRepositoryContextSnapshot[];
};

type QualifiedSandboxProfile = { image: string; proxyUrl: string };
type VerifiedReplayInputs = { plan: ReplayPlan; repositoryFullName: string; baseBranch: string };

type ReplayPolicyPin = {
  executionId: string;
  policyRevisionId: string;
  expectedPolicyDigest: string;
};

function exportReplaySnapshot(receipt: StagedReplay["receipt"]) {
  return {
    version: receipt.version,
    taskRevisionId: receipt.identity.taskRevisionId,
    sourceRunId: receipt.identity.sourceRunId,
    definitionRevisionId: receipt.identity.definitionRevisionId,
    definitionDigest: receipt.identity.definitionDigest,
    contextManifestSha256: receipt.identity.contextManifestSha256,
    checkoutSha: receipt.restored.checkoutSha,
    treeSha: receipt.restored.treeSha,
    inputBundleSha256: receipt.restored.bundleSha256,
    restorationReceiptSha256: receipt.receiptSha256,
    limits: receipt.qualification.limits,
    candidateChanges: receipt.qualification.candidateChanges,
  };
}

type IsolatedBenchmarkInputs = {
  sandbox: Pick<SandboxHandle, "id" | "repoPath" | "readFile" | "writeFile"> & {
    exec(
      command: string,
      args: string[],
      options?: Omit<SandboxExecOptions, "env">,
    ): ReturnType<SandboxHandle["exec"]>;
  };
  signal: AbortSignal;
  inputPath: string;
  snapshot: ReturnType<typeof exportReplaySnapshot>;
  readContext: Pick<
    FactoryRepositoryContextSnapshot,
    "repositoryId" | "commitSha" | "snapshotPath"
  >[];
  broker: BenchmarkReplayBroker;
};

export async function withIsolatedBenchmarkReplay<T>(
  input: BenchmarkSandboxInput & ReplayPolicyPin,
  execute: (result: IsolatedBenchmarkInputs) => Promise<T>,
) {
  if (input.connection.provider !== "vercel")
    throw new BenchmarkReplayUnavailable("This replay policy requires a Vercel sandbox.");
  const { factoryId, taskRevisionId, executionId, policyRevisionId, expectedPolicyDigest } = input;
  const { workspaceId, actorUserId } =
    "principal" in input
      ? input.principal
      : { workspaceId: input.access.workspace.id, actorUserId: input.access.user.id };
  return withBenchmarkSandbox(input, "isolated", async (restored, admin) => {
    const { sandbox, signal, inputPath, receipt, readContext } = restored;
    const snapshot = exportReplaySnapshot(receipt);
    const broker = await openBenchmarkReplayPolicy({
      admin,
      workspaceId,
      actorUserId,
      factoryId,
      taskRevisionId,
      executionId,
      policyRevisionId,
      expectedPolicyDigest,
      restorationReceiptSha256: snapshot.restorationReceiptSha256,
      signal,
    });
    signal.throwIfAborted();
    return execute({
      sandbox: {
        id: sandbox.id,
        repoPath: sandbox.repoPath,
        exec: (cmd, args, options) =>
          sandbox.exec(cmd, args, {
            ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
          }),
        readFile: (path) => observeUntilAbort(signal, () => sandbox.readFile(path)),
        writeFile: (path, contents, options) =>
          observeUntilAbort(signal, () => sandbox.writeFile(path, contents, options)),
      },
      signal,
      inputPath,
      snapshot,
      readContext: readContext.map(({ repositoryId, commitSha, snapshotPath }) => ({
        repositoryId,
        commitSha,
        snapshotPath,
      })),
      broker,
    });
  });
}

/** Keep the restored source in a fresh, nonpersistent sandbox with one brokered inference origin. */
export async function withQualifiedBenchmarkReplay<T>(
  input: BenchmarkSandboxInput & ReplayPolicyPin & { profile: QualifiedSandboxProfile },
  execute: (
    live: VerifiedReplayInputs & {
      sandbox: SandboxHandle;
      signal: AbortSignal;
      snapshot: ReturnType<typeof exportReplaySnapshot>;
    },
  ) => Promise<T>,
) {
  if (input.connection.provider !== "vercel" || process.env.WALLIE_SANDBOX_IMPL === "fake")
    throw new BenchmarkReplayUnavailable("Qualified live replay requires Vercel Sandbox.");
  const { workspaceId, actorUserId } =
    "principal" in input
      ? input.principal
      : {
          workspaceId: input.access.workspace.id,
          actorUserId: input.access.user.id,
        };
  return withBenchmarkSandbox(input, input.profile, async (restored, admin, inputs) => {
    const { sandbox, signal, receipt } = restored;
    const snapshot = exportReplaySnapshot(receipt);
    await openBenchmarkReplayPolicy({
      admin,
      workspaceId,
      actorUserId,
      factoryId: input.factoryId,
      taskRevisionId: input.taskRevisionId,
      executionId: input.executionId,
      policyRevisionId: input.policyRevisionId,
      expectedPolicyDigest: input.expectedPolicyDigest,
      restorationReceiptSha256: snapshot.restorationReceiptSha256,
      signal,
    });
    signal.throwIfAborted();
    return execute({ ...inputs, sandbox, signal, snapshot });
  });
}

async function withBenchmarkSandbox<T>(
  input: BenchmarkSandboxInput,
  purpose: "restore" | "isolated" | QualifiedSandboxProfile,
  inspect: (
    result: RestoredBenchmarkInputs,
    admin: ReturnType<typeof createSupabaseAdminClient>,
    inputs: VerifiedReplayInputs,
  ) => Promise<T>,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(lifetimeMs)]);
  const { plan, repository, baseBranch, recheckAccess } = await resolveBenchmarkReplay({
    ...input,
    signal,
  });
  const { repositoryFullName, repositoryId, installationId } = repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName))
    throw new BenchmarkReplayUnavailable("The recorded repository identity is invalid.");
  const token = await mintSandboxRepositoryToken({
    installationId,
    repositoryId,
    repositoryFullName,
    purpose: purpose === "restore" ? "checkout" : "benchmark-checkout",
    signal,
  });
  signal.throwIfAborted();
  const { connection } = input;
  const workspaceId =
    "principal" in input ? input.principal.workspaceId : input.access.workspace.id;
  const admin = "principal" in input ? input.principal.admin : createSupabaseAdminClient();
  const operationId = await reserveWorkspaceSandbox(admin, {
    workspaceId,
    provider: connection.provider,
    connection,
    acquisitionTimeoutMs: 60_000,
    timeoutMs: lifetimeMs,
  });
  let sandboxId: string | undefined;
  let dispose: SandboxHandle[typeof Symbol.asyncDispose];
  let staged: Awaited<ReturnType<typeof stageBenchmarkReplay>> | undefined;
  let result: T;
  try {
    const request: CreateUtilitySandboxInput = {
      workspaceId,
      ownerId: randomUUID(),
      timeoutMs: lifetimeMs,
      signal,
      onSandboxCreated: async (acquisition) => {
        const { sandboxId: id } = acquisition;
        sandboxId = id;
        if (!(await recordWorkspaceSandbox(admin, operationId, id))) {
          throw new WorkspaceDeletingError();
        }
        await input.onSandboxCreated?.(acquisition);
      },
    };
    const acquired = await acquireReplaySandbox(request, connection, purpose);
    const { sandbox } = acquired;
    sandboxId = sandbox.id;
    dispose = sandbox[Symbol.asyncDispose]?.bind(sandbox);
    result = await observeUntilAbort(signal, async () => {
      await recheckAccess();
      signal.throwIfAborted();
      const readContext = await materializeFactoryRepositoryContext({
        admin,
        workspaceId,
        factoryId: input.factoryId,
        sandbox,
        repositoryIds: [...plan.readRepositories.keys()],
        expectedCommits: plan.readRepositories,
        signal,
      });
      signal.throwIfAborted();
      const restored = await stageBenchmarkReplay({
        sandbox,
        provider: connection.provider,
        connectionRevision: connection.revision,
        repositoryUrl: `https://github.com/${repositoryFullName}.git`,
        token,
        plan,
        readContext,
        signal,
        ...(purpose === "restore"
          ? {}
          : { payloadKind: purpose === "isolated" ? "isolated_context" : "qualified_task" }),
      });
      // Provider writes cannot always be canceled. Discard a bundle that arrives
      // after the owning operation has moved on to sandbox teardown.
      if (signal.aborted) {
        await restored.cleanup().catch(() => undefined);
        signal.throwIfAborted();
      }
      staged = restored;
      await acquired.seal?.(signal);
      signal.throwIfAborted();
      await recheckAccess();
      signal.throwIfAborted();
      return inspect(
        { sandbox, signal, inputPath: restored.inputPath, receipt: restored.receipt, readContext },
        admin,
        { plan, repositoryFullName, baseBranch },
      );
    });
  } finally {
    await staged?.cleanup().catch(() => undefined);
    if (sandboxId) {
      try {
        await stopSandboxById(sandboxId, { connection, throwOnError: true });
        await settleWorkspaceResource(admin, operationId, true);
      } catch (error) {
        await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
        throw error;
      } finally {
        await dispose?.().catch(() => undefined);
      }
    }
  }
  signal.throwIfAborted();
  return result;
}

async function acquireReplaySandbox(
  input: CreateUtilitySandboxInput,
  connection: SandboxConnection,
  purpose: "restore" | "isolated" | QualifiedSandboxProfile,
): Promise<{ sandbox: SandboxHandle; seal?: (signal: AbortSignal) => Promise<void> }> {
  if (purpose === "restore") return { sandbox: await createUtilitySandbox(input, connection) };
  if (purpose === "isolated") {
    const sandbox = await createBenchmarkReplaySandbox(input, connection);
    return { sandbox, seal: (signal) => sealBenchmarkReplaySandbox(sandbox, signal) };
  }
  if (connection.provider !== "vercel")
    throw new BenchmarkReplayUnavailable("Qualified replay requires Vercel Sandbox.");
  const { createVercelQualifiedBenchmarkReplaySandbox } = await import("@/lib/sandbox/vercel");
  const sandbox = await runBoundedSandboxProviderOperation<
    Awaited<ReturnType<typeof createVercelQualifiedBenchmarkReplaySandbox>>
  >({
    operation: "acquire",
    provider: "vercel",
    timeoutMs: 60_000,
    signal: input.signal,
    onLateSuccess: (late) => late.stop(),
    run: (signal) =>
      createVercelQualifiedBenchmarkReplaySandbox({ ...input, signal }, connection, purpose),
  });
  return { sandbox, seal: (signal) => sandbox.sealBenchmarkInference(signal) };
}
