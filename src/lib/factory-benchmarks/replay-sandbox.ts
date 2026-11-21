import "server-only";

import { randomUUID } from "node:crypto";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import {
  materializeFactoryRepositoryContext,
  type FactoryRepositoryContextSnapshot,
} from "@/lib/pipeline/repository-context";
import { restoreRetryCheckpoint } from "@/lib/pipeline/retry-checkpoint-git";
import { createUtilitySandbox, stopSandboxById } from "@/lib/sandbox";
import { checkoutSandboxCheckpoint } from "@/lib/sandbox/checkout";
import type { SandboxConnection, SandboxHandle } from "@/lib/sandbox/types";
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
) {
  const process = await sandbox.exec(cmd, args, { signal, env: gitEnvironment });
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
  let complete = false;
  try {
    // An ephemeral command environment keeps installation credentials off disk.
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

    const readRepositories = [...plan.readRepositories].map(([id, commitSha]) => ({
      id,
      commitSha,
    }));
    const payload = JSON.stringify({
      version: 1,
      identity,
      runtime: plan.runtime,
      readRepositories,
      text,
    });
    const bundleSha256 = replaySha256(payload);
    await runRestoreCommand(sandbox, "mkdir", ["-m", "700", directory], signal);
    await sandbox.writeFile(inputPath, payload, { mode: 0o600 });
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
        readRepositories,
      },
      qualification: { limits, candidateChanges: plan.candidateChanges },
    };
    complete = true;
    return {
      inputPath,
      receipt: { ...receipt, receiptSha256: replaySha256(JSON.stringify(receipt)) },
      cleanup: () =>
        runRestoreCommand(sandbox, "rm", ["-rf", directory], AbortSignal.timeout(5_000)),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BenchmarkReplayUnavailable) throw error;
    throw new BenchmarkReplayUnavailable("The exact starting source could not be restored.");
  } finally {
    if (!complete)
      await runRestoreCommand(sandbox, "rm", ["-rf", directory], AbortSignal.timeout(5_000)).catch(
        () => undefined,
      );
  }
}

export async function withRestoredBenchmarkInputs<T>(
  input: Parameters<typeof resolveBenchmarkReplay>[0] & { connection: SandboxConnection },
  inspect: (
    result: Omit<Awaited<ReturnType<typeof stageBenchmarkReplay>>, "cleanup"> & {
      sandbox: SandboxHandle;
      readContext: Awaited<ReturnType<typeof materializeFactoryRepositoryContext>>;
    },
  ) => Promise<T>,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(lifetimeMs)]);
  const { plan, repository, recheckAccess } = await resolveBenchmarkReplay({ ...input, signal });
  const { repositoryFullName, repositoryId, installationId } = repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName))
    throw new BenchmarkReplayUnavailable("The recorded repository identity is invalid.");
  const token = await mintSandboxRepositoryToken({
    installationId,
    repositoryId,
    repositoryFullName,
    purpose: "checkout",
    signal,
  });
  const { connection, access } = input;
  const admin = createSupabaseAdminClient();
  const operationId = await reserveWorkspaceSandbox(admin, {
    workspaceId: access.workspace.id,
    provider: connection.provider,
    connection,
    acquisitionTimeoutMs: 60_000,
    timeoutMs: lifetimeMs,
  });
  let sandboxId: string | undefined;
  let sandbox: SandboxHandle | undefined;
  try {
    sandbox = await createUtilitySandbox(
      {
        workspaceId: access.workspace.id,
        ownerId: randomUUID(),
        timeoutMs: lifetimeMs,
        signal,
        onSandboxCreated: async ({ sandboxId: id }) => {
          sandboxId = id;
          if (!(await recordWorkspaceSandbox(admin, operationId, id))) {
            throw new WorkspaceDeletingError();
          }
        },
      },
      connection,
    );
    sandboxId = sandbox.id;
    await recheckAccess();
    const readContext = await materializeFactoryRepositoryContext({
      admin,
      workspaceId: access.workspace.id,
      factoryId: input.factoryId,
      sandbox,
      repositoryIds: [...plan.readRepositories.keys()],
      expectedCommits: plan.readRepositories,
      signal,
    });
    const staged = await stageBenchmarkReplay({
      sandbox,
      provider: connection.provider,
      connectionRevision: connection.revision,
      repositoryUrl: `https://github.com/${repositoryFullName}.git`,
      token,
      plan,
      readContext,
      signal,
    });
    try {
      await recheckAccess();
      return await inspect({
        sandbox,
        inputPath: staged.inputPath,
        receipt: staged.receipt,
        readContext,
      });
    } finally {
      await staged.cleanup().catch(() => undefined);
    }
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxById(sandboxId, { connection, throwOnError: true });
        await settleWorkspaceResource(admin, operationId, true);
      } catch (error) {
        await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
        throw error;
      } finally {
        await sandbox?.[Symbol.asyncDispose]?.().catch(() => undefined);
      }
    }
  }
}
