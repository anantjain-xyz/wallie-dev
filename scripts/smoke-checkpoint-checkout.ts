import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { checkoutSandboxCheckpoint } from "../src/lib/sandbox/checkout";
import { initializeCheckpointRepository } from "../src/lib/sandbox/setup";
import {
  createUtilitySandbox,
  hasRecoverableSandboxSource,
  stopSandboxById,
} from "../src/lib/sandbox";
import type { SandboxHandle, SandboxConnection } from "../src/lib/sandbox/types";

async function main() {
  const [repository, ref, sha] = process.argv.slice(2);
  if (!repository || !ref || !sha) {
    throw new Error(
      "Usage: smoke-checkpoint-checkout.ts <owner/repo> <full-retained-ref> <expected-sha>",
    );
  }
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  if (!token || !teamId || !projectId)
    throw new Error(
      "Configure the operator VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID before this live smoke test.",
    );
  const connection: SandboxConnection = {
    provider: "vercel",
    revision: "checkpoint-smoke",
    credentials: { token, teamId, projectId },
  };
  const owner = randomUUID();
  const branch = `wallie/checkout-smoke-${owner}`;
  const signal = AbortSignal.timeout(120_000);
  let handle: SandboxHandle | undefined;
  let sandboxId: string | undefined;
  try {
    handle = await createUtilitySandbox(
      {
        workspaceId: owner,
        ownerId: owner,
        timeoutMs: 180_000,
        signal,
        onSandboxCreated: async (metadata) => {
          sandboxId = metadata.sandboxId;
        },
      },
      connection,
    );
    await initializeCheckpointRepository({
      handle,
      repoAlreadyCloned: false,
      request: {
        sessionId: owner,
        workspaceId: owner,
        ownerId: owner,
        repoFullName: repository,
        branch,
        baseBranch: "deliberately-unused-default",
        mode: { kind: "checkpoint", ref, sha },
        installationToken: process.env.GH_TOKEN ?? "",
        agentProvider: "codex",
        signal,
      },
    });
    await checkoutSandboxCheckpoint({ sandbox: handle, branch, checkpoint: { ref, sha }, signal });
    const command = await handle.exec("git", ["rev-parse", "HEAD"], { signal });
    assert.equal((await command.output()).stdout.trim(), sha);
    assert.equal(await command.exitCode, 0);
    await assert.rejects(
      checkoutSandboxCheckpoint({
        sandbox: handle,
        branch,
        checkpoint: { ref, sha: sha === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40) },
        signal,
      }),
      { name: "SandboxCheckpointRecoveryError", code: "sha_mismatch" },
    );
    await assert.rejects(
      checkoutSandboxCheckpoint({
        sandbox: handle,
        branch,
        checkpoint: { ref: `refs/heads/wallie-missing-${owner}`, sha },
        signal,
      }),
      { name: "SandboxCheckpointRecoveryError", code: "checkpoint_unavailable" },
    );
    console.log(
      JSON.stringify({
        provider: "vercel",
        sandboxId,
        repository,
        ref,
        sha,
        branch,
        exactCheckout: "passed",
        mismatchedRef: "rejected",
        missingRef: "rejected",
      }),
    );
  } finally {
    if (sandboxId) {
      await stopSandboxById(sandboxId, { connection, throwOnError: true });
      assert.equal(
        await hasRecoverableSandboxSource(sandboxId, connection),
        false,
        "Smoke sandbox must be stopped and its source removed",
      );
      console.log(JSON.stringify({ sandboxId, cleanup: "confirmed" }));
    }
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Checkpoint smoke failed.");
  process.exitCode = 1;
});
