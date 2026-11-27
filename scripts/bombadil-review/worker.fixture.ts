import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { it, vi } from "vitest";

import {
  adminClient,
  checked,
  claimJob,
  configureTransport,
  createGitFixture,
  loadProduction,
} from "../../test/release/harness";

it("processes the exact job produced by the local browser review", async () => {
  const { WALLIE_REVIEW_WORKSPACE: workspaceId, WALLIE_REVIEW_WORKER_DIR: root } = process.env;
  assert(workspaceId && root);
  const pipelineId = "d1b2c3d4-0001-4000-8000-000000000001";
  const admin = adminClient();
  let transport: Awaited<ReturnType<typeof configureTransport>> | undefined;
  try {
    const { remote } = await createGitFixture(root);
    transport = await configureTransport({
      root,
      remote,
      repositoryName: "acme-corp/webapp",
      repositoryNumericId: 100001,
      run: async function* () {
        yield {
          type: "completion",
          taskComplete: true,
          summary: "Synthetic browser review fixture completed",
          finalOutput: "# Fixture output\n\nDeterministic local artifact.",
        };
      },
    });
    const { createSessionWithFirstJob, processPipelineJob } = await loadProduction();
    const stages = await checked(
      admin
        .from("pipeline_stages")
        .select("id,slug")
        .eq("workspace_id", workspaceId)
        .eq("pipeline_id", pipelineId)
        .in("slug", ["plan", "build"])
        .order("position"),
    );
    assert.deepEqual(
      stages.map((stage) => stage.slug),
      ["plan", "build"],
    );
    const { sessionId, jobId: seedJobId } = await createSessionWithFirstJob({
      admin,
      workspaceId,
      creatorMemberId: "c1b2c3d4-0001-4000-8000-000000000001",
      githubRepositoryId: "12b2c3d4-0001-4000-8000-000000000001",
      pipelineId,
      selectedStageIds: stages.map((stage) => stage.id),
      linearIssueId: null,
      linearIssueUrl: null,
      modelName: "gpt-5.5",
      modelProvider: "codex",
      title: "Bombadil synthetic review",
      promptMd: "Produce a local-only fixture artifact.",
    });
    async function processJob(id: string) {
      const result = await processPipelineJob({ admin, job: await claimJob(admin, id) });
      if (result.result !== "success") {
        const { last_error } = await checked(
          admin.from("agent_jobs").select("last_error").eq("id", id).single(),
        );
        throw new Error(`The local fake attempt did not finish: ${last_error ?? result.result}`);
      }
    }
    assert(seedJobId);
    await processJob(seedJobId);
    const session = await checked(
      admin
        .from("sessions")
        .select("number")
        .eq("workspace_id", workspaceId)
        .eq("id", sessionId)
        .single(),
    );
    await writeFile(join(root, "ready.json"), JSON.stringify({ number: session.number }));

    await vi.waitFor(() => access(join(root, "browser-ready")), {
      timeout: 240_000,
      interval: 200,
    });
    const jobId = await vi.waitFor(
      async () => {
        const job = await checked(
          admin
            .from("agent_jobs")
            .select("id")
            .eq("session_id", sessionId)
            .eq("status", "queued")
            .maybeSingle(),
        );
        assert(job, "No browser decision enqueued a job for the fixture entry.");
        return job.id;
      },
      { timeout: 50_000, interval: 200 },
    );
    await processJob(jobId);
    assert.equal(transport.runnerStarts, 2);
  } finally {
    for (const sandbox of transport?.sandboxes ?? []) await sandbox.stop();
  }
}, 360_000);
