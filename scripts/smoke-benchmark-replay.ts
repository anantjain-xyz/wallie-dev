import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  replayCommitSchema,
  replaySha256,
  type ReplayPlan,
} from "../src/lib/factory-benchmarks/replay-contracts";
import { stageBenchmarkReplay } from "../src/lib/factory-benchmarks/replay-sandbox";
import {
  createUtilitySandbox,
  hasRecoverableSandboxSource,
  stopSandboxById,
} from "../src/lib/sandbox";
import type { SandboxConnection } from "../src/lib/sandbox/types";

async function main() {
  const [ref, commit] = process.argv.slice(2);
  const sha = replayCommitSchema.parse(commit);
  if (!ref?.startsWith("refs/heads/wallie/checkpoints/"))
    throw new Error("Provide a retained fixture checkpoint ref and expected commit.");
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  if (!token || !teamId || !projectId)
    throw new Error("The documented Vercel smoke credentials are required.");
  const connection: SandboxConnection = {
    provider: "vercel",
    revision: "benchmark-replay-smoke",
    credentials: { token, teamId, projectId },
  };
  const repositoryUrl = "https://github.com/anantjain-xyz/wallie-dev.git";
  const signal = AbortSignal.timeout(180_000);
  const originalPrompt = "Inspect the retained fixture checkout.";
  const definitionJson = '{"fixture":"benchmark-replay"}';
  const contextManifestJson = '{"version":1,"fixture":true}';
  const document = { revisionId: randomUUID(), body: "Frozen document body." };
  const memory = { revisionId: randomUUID(), body: "Frozen memory body." };
  const plan: ReplayPlan = {
    identity: {
      taskRevisionId: randomUUID(),
      sourceRunId: randomUUID(),
      sourceSessionId: randomUUID(),
      sourceJobId: randomUUID(),
      sourceAttemptCount: 1,
      repositoryId: randomUUID(),
      definitionRevisionId: randomUUID(),
      inputSha: sha,
      inputRef: ref,
      checkoutSha: sha,
      retryBundleSha256: null,
      definitionDigest: replaySha256(definitionJson),
      contextManifestSha256: replaySha256(contextManifestJson),
      originalPromptSha256: replaySha256(originalPrompt),
      renderedPromptSha256: replaySha256("Original run rendered prompt"),
      rendererVersion: 6,
    },
    runtime: {
      harness: "codex",
      model: "gpt-5.5",
      worker: "node",
      sandboxProvider: "vercel",
      sandboxConnectionRevision: null,
      stageId: randomUUID(),
      runType: "code",
      agentEffort: null,
      maxTurns: null,
    },
    text: {
      originalPrompt,
      definitionJson,
      contextManifestJson,
      required: [{ key: "session/prompt", body: originalPrompt }],
      documents: [document],
      memories: [memory],
      conversation: [],
      skills: [],
      agentPrompt: { revisionId: randomUUID(), body: "Use the approved fixture instructions." },
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

  async function restoreAndStop() {
    let sandboxId: string | undefined;
    try {
      const owner = randomUUID();
      const sandbox = await createUtilitySandbox(
        {
          workspaceId: owner,
          ownerId: owner,
          timeoutMs: 120_000,
          signal,
          onSandboxCreated: async ({ sandboxId: id }) => {
            sandboxId = id;
          },
        },
        connection,
      );
      sandboxId = sandbox.id;
      const staged = await stageBenchmarkReplay({
        sandbox,
        provider: "vercel",
        repositoryUrl,
        plan,
        signal,
      });
      try {
        assert.equal(staged.receipt.restored.checkoutSha, sha);
        const payload = await sandbox.readFile(staged.inputPath);
        assert.ok(payload);
        assert.equal(replaySha256(payload), staged.receipt.restored.bundleSha256);
        assert.ok(payload.includes(document.body) && payload.includes(memory.body));
        return { sandboxId, receipt: staged.receipt };
      } finally {
        await staged.cleanup();
      }
    } finally {
      if (sandboxId) {
        await stopSandboxById(sandboxId, { connection, throwOnError: true });
        assert.equal(await hasRecoverableSandboxSource(sandboxId, connection), false);
      }
    }
  }

  const original = await restoreAndStop();
  const restored = await restoreAndStop();
  assert.notEqual(restored.sandboxId, original.sandboxId);
  assert.equal(restored.receipt.receiptSha256, original.receipt.receiptSha256);
  console.log(
    JSON.stringify({
      provider: "vercel",
      repository: "anantjain-xyz/wallie-dev",
      ref,
      sha,
      tree: restored.receipt.restored.treeSha,
      inputDigest: restored.receipt.restored.bundleSha256,
      receiptDigest: restored.receipt.receiptSha256,
      sandboxIds: [original.sandboxId, restored.sandboxId],
      stoppedAndSourceRemoved: true,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark replay smoke failed.");
  process.exitCode = 1;
});
