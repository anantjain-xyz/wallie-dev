import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import type { AgentEvent } from "@/lib/agent-runner/types";
import {
  adminClient,
  checked,
  claimJob,
  configureTransport,
  git,
  loadProduction,
  readManifest,
} from "./harness";

it("restores the next stage solely from durable selected input in a fresh OS process", async () => {
  const manifest = await readManifest();
  const admin = adminClient();
  let observedSha = "";
  const transport = await configureTransport({
    ...manifest,
    run: async function* (input) {
      assert(input.sandbox);
      observedSha = await git(input.sandbox.repoPath, "rev-parse", "HEAD");
      expect(observedSha).toBe(manifest.expectedSha);
      for (const [path, contents] of Object.entries(manifest.expectedFiles))
        expect(await input.sandbox.readFile(`${input.sandbox.repoPath}/${path}`)).toBe(contents);
      yield {
        type: "completion",
        taskComplete: true,
        summary: "Verified",
        finalOutput: "# Verify\n\nReviewed source survived the worker process restart.",
      } satisfies AgentEvent;
    },
  });
  try {
    const production = await loadProduction();
    const saved = await production.loadPinnedSessionJobGitInput({
      admin,
      jobId: manifest.jobId,
      sessionId: manifest.sessionId,
      workspaceId: manifest.workspaceId,
    });
    expect(saved?.input_sha).toBe(manifest.expectedSha);
    const job = await claimJob(admin, manifest.jobId);
    const result = await production.processPipelineJob({ admin, job });
    expect(result.result).toBe("success");
    const checkpoint = await checked(
      admin.from("session_git_checkpoints").select("*").eq("run_id", result.runId!).single(),
    );
    expect(checkpoint.output_kind).toBe("no-code");
    await writeFile(
      manifest.outputPath,
      JSON.stringify({
        pid: process.pid,
        inputSha: observedSha,
        outputSha: checkpoint.output_sha,
        outputKind: checkpoint.output_kind,
      }),
      { mode: 0o600 },
    );
  } finally {
    for (const sandbox of transport.sandboxes) await sandbox.stop();
    vi.unstubAllGlobals();
  }
});
