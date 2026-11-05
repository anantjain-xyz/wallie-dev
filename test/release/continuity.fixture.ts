import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

import type { AgentEvent } from "@/lib/agent-runner/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createArtifactSourceAnchor } from "@/features/sessions/review/source-anchor";
import {
  adminClient,
  checked,
  claimJob,
  cleanupLocalFixture,
  configureTransport,
  createGitFixture,
  deferred,
  fixtureIds,
  git,
  loadProduction,
  releaseState,
  rpc,
  setRelease,
  type Manifest,
} from "./harness";

const exec = promisify(execFile);
const originalCode = 'export const original = "preserve me";\n';
const planCode = 'export const planned = "reviewed plan";\n';
const buildCode = 'export const feature = "first build";\n';
const revisedCode = 'export const feature = "reviewed revision";\n';
const submittedInlineFeedback = "Keep the original implementation while revising the feature.";
const laterInlineEdit = "This edited comment has not been submitted to the revision.";
const laterInlineReply = "This later reply must remain unsent.";

async function dueAt(value: string | null) {
  const milliseconds = value ? Math.max(0, Date.parse(value) - Date.now() + 25) : 0;
  assert(milliseconds < 20_000, "Fixture retries should use the first bounded production backoff.");
  if (milliseconds) await delay(milliseconds);
}

it("preserves reviewed source and one PR across stages, rejection, pause, recovery, replacement and a fresh OS worker", async () => {
  const admin = adminClient();
  const priorRelease = await releaseState(admin);
  const root = await mkdtemp(join(tmpdir(), "wallie-continuity-release-"));
  const ids = fixtureIds();
  const repositoryName = `wallie-fixture/continuity-${ids.workspaceId}`;
  const repositoryNumericId = Math.floor(Date.now() / 1000);
  let userId: string | undefined;
  let signOutReviewer: (() => Promise<unknown>) | undefined;
  let staleRelease: ReturnType<typeof deferred<void>> | undefined;
  let staleWorker: Promise<unknown> | undefined;
  let stopSandboxes: (() => Promise<void>) | undefined;
  const evidencePath = process.env.WALLIE_CONTINUITY_EVIDENCE_PATH;
  let evidence: Record<string, unknown> | undefined;
  const persistEvidence = async () => {
    if (!evidencePath || !evidence) return;
    await mkdir(dirname(resolve(evidencePath)), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    const { remote, writer, baseSha } = await createGitFixture(root);
    let phase: "plan" | "build" | "stale" | "revision" = "plan";
    let planSha = "";
    let buildSha = "";
    const staleStarted = deferred<{ runId: string; sandboxPath: string }>();
    staleRelease = deferred<void>();
    const transport = await configureTransport({
      root,
      remote,
      repositoryName,
      repositoryNumericId,
      run: async function* (input) {
        assert(input.sandbox && input.runId);
        const mode = phase;
        const sandbox = input.sandbox;
        expect(await sandbox.readFile(`${sandbox.repoPath}/src/original.ts`)).toBe(originalCode);
        const head = await git(sandbox.repoPath, "rev-parse", "HEAD");
        if (mode === "plan") {
          expect(head).toBe(baseSha);
          await sandbox.writeFile(`${sandbox.repoPath}/src/plan.ts`, planCode);
        } else {
          expect(await sandbox.readFile(`${sandbox.repoPath}/src/plan.ts`)).toBe(planCode);
          expect(head).toBe(mode === "build" ? planSha : buildSha);
          if (mode === "build")
            await sandbox.writeFile(`${sandbox.repoPath}/src/feature.ts`, buildCode);
          else {
            expect(await sandbox.readFile(`${sandbox.repoPath}/src/feature.ts`)).toBe(buildCode);
            expect(input.prompt).toContain("Preserve the original file and revise the feature");
            expect(input.prompt).toContain(submittedInlineFeedback);
            expect(input.prompt).not.toContain(laterInlineEdit);
            expect(input.prompt).not.toContain(laterInlineReply);
            if (mode === "stale") {
              await sandbox.writeFile(
                `${sandbox.repoPath}/stale-only.ts`,
                "unaccepted old worker output",
              );
              staleStarted.resolve({ runId: input.runId, sandboxPath: sandbox.repoPath });
              await staleRelease!.promise;
            } else {
              expect(existsSync(join(sandbox.repoPath, "stale-only.ts"))).toBe(false);
              await sandbox.writeFile(`${sandbox.repoPath}/src/feature.ts`, revisedCode);
              await sandbox.writeFile(
                `${sandbox.repoPath}/src/revision.ts`,
                "export const revision = 2;\n",
              );
            }
          }
        }
        yield {
          type: "completion",
          taskComplete: true,
          summary: "Fixture completed",
          finalOutput: `# ${mode}\n\nReview the preserved source checkpoint.`,
          usage: { inputTokens: 7, outputTokens: 3 },
        } satisfies AgentEvent;
      },
    });
    stopSandboxes = async () => {
      for (const sandbox of transport.sandboxes) {
        await sandbox.stop();
        expect(existsSync(sandbox.repoPath)).toBe(false);
      }
    };
    const production = await loadProduction();
    const account = await admin.auth.admin.createUser({
      email: `continuity-${ids.workspaceId}@example.invalid`,
      password: `fixture-${ids.workspaceId}`,
      email_confirm: true,
    });
    if (account.error) throw account.error;
    assert(account.data.user);
    userId = account.data.user.id;
    const reviewer = createClient<Database>(
      process.env.WALLIE_CONTINUITY_SUPABASE_URL!,
      process.env.WALLIE_CONTINUITY_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const signedIn = await reviewer.auth.signInWithPassword({
      email: account.data.user.email!,
      password: `fixture-${ids.workspaceId}`,
    });
    if (signedIn.error) throw signedIn.error;
    assert(signedIn.data.session);
    expect(
      JSON.parse(
        Buffer.from(signedIn.data.session.access_token.split(".")[1], "base64url").toString(),
      ).role,
    ).toBe("authenticated");
    signOutReviewer = () => reviewer.auth.signOut();
    await checked(
      admin.from("workspaces").insert({
        id: ids.workspaceId,
        slug: `continuity-${ids.workspaceId}`,
        name: "Isolated continuity release",
        created_by: userId,
      }),
    );
    await checked(
      admin.from("workspace_members").insert({
        id: ids.memberId,
        workspace_id: ids.workspaceId,
        user_id: userId,
        kind: "human",
        role: "owner",
        email: account.data.user.email,
      }),
    );
    await checked(
      admin.from("github_installations").insert({
        id: ids.installationId,
        workspace_id: ids.workspaceId,
        installation_id: repositoryNumericId,
        installation_url: "https://github.com/apps/wallie-fixture/installations/1",
        app_id: 1,
        target_type: "Organization",
        target_name: "wallie-fixture",
        permissions: { contents: "write", pull_requests: "write" },
      }),
    );
    await checked(
      admin.from("github_repositories").insert({
        id: ids.repositoryId,
        workspace_id: ids.workspaceId,
        github_installation_id: ids.installationId,
        repo_id: repositoryNumericId,
        name: repositoryName.split("/")[1],
        full_name: repositoryName,
        private: true,
        html_url: `https://github.com/${repositoryName}`,
        default_branch: "main",
        default_programming_language: "TypeScript",
      }),
    );
    await checked(
      admin
        .from("pipelines")
        .insert({ id: ids.pipelineId, workspace_id: ids.workspaceId, name: "Continuity fixture" }),
    );
    await checked(
      admin.from("pipeline_stages").insert(
        ids.stageIds.map((id, index) => ({
          id,
          pipeline_id: ids.pipelineId,
          workspace_id: ids.workspaceId,
          position: index + 1,
          slug: ["plan", "build", "verify"][index],
          name: ["Plan", "Build", "Verify"][index],
          anyone_can_approve: true,
          prompt_template_md:
            "{{session.prompt}}\n{{attempt.feedback}}\n{{artifact.previousStages.plan}}",
        })),
      ),
    );
    await checked(
      admin.from("workspace_agent_config").insert([
        { workspace_id: ids.workspaceId, key: "agent_provider", value_json: "codex" },
        { workspace_id: ids.workspaceId, key: "agent_model", value_json: "gpt-5.5" },
      ]),
    );

    await setRelease(admin, true, "Enable isolated local continuity acceptance fixture");
    const created = await production.createSessionWithFirstJob({
      admin,
      creatorMemberId: ids.memberId,
      githubRepositoryId: ids.repositoryId,
      linearIssueId: null,
      linearIssueUrl: null,
      modelName: "gpt-5.5",
      modelProvider: "codex",
      pipelineId: ids.pipelineId,
      selectedStageIds: ids.stageIds,
      promptMd: "Implement the deterministic continuity fixture.",
      title: "Continuity release proof",
      workspaceId: ids.workspaceId,
    });
    const sessionId = created.sessionId;
    const enrollment = await rpc<Array<{ state: string }>>(
      admin,
      "get_session_git_continuity_state",
      { p_session_id: sessionId },
    );
    expect(enrollment[0]?.state).toBe("enabled");
    const session = async () =>
      checked(admin.from("sessions").select("*").eq("id", sessionId).single());
    const checkpoint = async (runId: string) =>
      checked(admin.from("session_git_checkpoints").select("*").eq("run_id", runId).single());
    const approve = async () => {
      const current = await session();
      assert(current.current_artifact_id);
      const result = await production.handleApproval({
        admin,
        approverMemberId: ids.memberId,
        expectedArtifactId: current.current_artifact_id,
        expectedStageId: current.current_stage_id,
        expectedWorkspaceId: ids.workspaceId,
        sessionId,
        version: current.current_artifact_version,
      });
      expect(result.success).toBe(true);
      assert(result.jobId);
      return result.jobId;
    };
    const canonical = async () => {
      const result = await production.drainCanonicalPullRequests(admin, {
        sessionId,
        limit: 1,
        timeoutMs: 20_000,
      });
      expect(result).toEqual({ processed: 1, failed: 0 });
      expect(transport.createCount).toBe(1);
      expect(transport.prs).toHaveLength(1);
      const epoch = await checked(
        admin.from("session_pr_epochs").select("*").eq("session_id", sessionId).single(),
      );
      expect(epoch.pr_number).toBe(1);
      expect(await git(remote, "rev-parse", `refs/heads/${epoch.branch_name}`)).toBe(
        transport.prs[0].head.sha,
      );
      return epoch;
    };

    // A completed result is durable before acceptance; pausing must preserve it.
    transport.blockedCheckpointPush = true;
    const planJob = await claimJob(admin, created.jobId);
    expect((await production.processPipelineJob({ admin, job: planJob })).result).toBe("idle");
    const planRun = await checked(
      admin
        .from("agent_runs")
        .select("*")
        .eq("agent_job_id", planJob.id)
        .eq("attempt_count", planJob.attempt_count)
        .single(),
    );
    const source = await checked(
      admin.from("session_source_deliveries").select("*").eq("run_id", planRun.id).single(),
    );
    expect(Boolean(source.checkpoint_path || source.bundle_base64)).toBe(true);
    expect((await session()).current_artifact_id).toBeNull();
    expect(existsSync(transport.sandboxes[0].repoPath)).toBe(false);
    await setRelease(admin, false, "Exercise captured-result recovery while paused");
    transport.blockedCheckpointPush = false;
    const publication = await checked(
      admin.from("session_checkpoint_publications").select("*").eq("run_id", planRun.id).single(),
    );
    await dueAt(publication.next_attempt_at);
    expect(
      await production.drainCheckpointPublications(admin, { runId: planRun.id, limit: 1 }),
    ).toEqual({ adopted: 1, failed: 0 });
    planSha = (await checkpoint(planRun.id)).output_sha;
    expect(transport.runnerStarts).toBe(1);
    expect((await session()).phase_status).toBe("awaiting_review");
    expect(await production.drainCanonicalPullRequests(admin, { sessionId, limit: 1 })).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(transport.createCount).toBe(0);
    await setRelease(admin, true, "Resume canonical publication after durable recovery");
    const firstEpoch = await canonical();

    const buildJobId = await approve();
    await writeFile(join(writer, "src/original.ts"), "unreviewed default branch replacement\n");
    await git(writer, "add", ".");
    await git(writer, "commit", "-m", "Default branch moved between stages");
    await git(writer, "push", "origin", "main");
    const movedMain = await git(writer, "rev-parse", "HEAD");
    expect(movedMain).not.toBe(planSha);
    phase = "build";
    const buildJob = await claimJob(admin, buildJobId);
    const buildResult = await production.processPipelineJob({ admin, job: buildJob });
    expect(buildResult.result).toBe("success");
    buildSha = (await checkpoint(buildResult.runId!)).output_sha;
    expect((await canonical()).id).toBe(firstEpoch.id);

    const reviewedBeforeComments = await session();
    const reviewedArtifact = await checked(
      admin
        .from("session_artifacts")
        .select("*")
        .eq("id", reviewedBeforeComments.current_artifact_id!)
        .single(),
    );
    assert(typeof reviewedArtifact.artifact_json === "string");
    const thread = await rpc<Tables<"artifact_review_threads">>(
      reviewer,
      "create_artifact_review_thread_once",
      {
        p_request_id: randomUUID(),
        p_workspace_id: ids.workspaceId,
        p_session_id: sessionId,
        p_stage_id: reviewedBeforeComments.current_stage_id,
        p_artifact_id: reviewedArtifact.id,
        p_artifact_version: reviewedArtifact.version,
        p_anchor: createArtifactSourceAnchor(
          reviewedArtifact.artifact_json,
          0,
          Math.min(7, Array.from(reviewedArtifact.artifact_json).length),
        ),
        p_kind: "discussion",
        p_body: submittedInlineFeedback,
      },
    );
    const submittedComment = await checked(
      admin.from("artifact_review_comments").select("*").eq("thread_id", thread.id).single(),
    );
    const reviewed = await session();
    const rejectInput = {
      admin,
      expectedArtifactId: reviewed.current_artifact_id!,
      expectedStageId: reviewed.current_stage_id,
      expectedWorkspaceId: ids.workspaceId,
      feedbackText: "Preserve the original file and revise the feature",
      requestedByMemberId: ids.memberId,
      sessionId,
      version: reviewed.current_artifact_version,
      feedbackSubmission: {
        requestId: randomUUID(),
        expectedReviewRevision: reviewed.artifact_review_revision,
        selectedThreadIds: [thread.id],
      },
    };
    const rejection = await production.handleRejection(rejectInput);
    expect(rejection.success).toBe(true);
    assert(rejection.jobId);
    assert(rejection.feedbackBatchId);
    const replay = await production.handleRejection(rejectInput);
    expect(replay.success).toBe(true);
    expect(replay.jobId).toBe(rejection.jobId);
    expect(replay.feedbackBatchId).toBe(rejection.feedbackBatchId);
    expect((await session()).rejection_count).toBe(1);

    await rpc(reviewer, "write_artifact_review_comment_once", {
      p_request_id: randomUUID(),
      p_workspace_id: ids.workspaceId,
      p_thread_id: thread.id,
      p_comment_id: submittedComment.id,
      p_expected_revision: submittedComment.revision,
      p_body: laterInlineEdit,
    });
    await rpc(reviewer, "write_artifact_review_comment_once", {
      p_request_id: randomUUID(),
      p_workspace_id: ids.workspaceId,
      p_thread_id: thread.id,
      p_body: laterInlineReply,
    });
    const savedBatch = await checked(
      admin
        .from("artifact_feedback_batches")
        .select("*")
        .eq("id", rejection.feedbackBatchId)
        .single(),
    );
    const savedThread = await checked(
      admin
        .from("artifact_feedback_batch_threads")
        .select("*")
        .eq("batch_id", rejection.feedbackBatchId)
        .single(),
    );
    expect(savedBatch.checkpoint_run_id).toBe(buildResult.runId);
    expect(savedBatch.job_id).toBe(rejection.jobId);
    expect(savedBatch.rendered_feedback_text).toContain(submittedInlineFeedback);
    expect(savedBatch.rendered_feedback_text).not.toContain(laterInlineEdit);
    expect(savedBatch.rendered_feedback_text).not.toContain(laterInlineReply);
    expect(savedThread.thread_revision).toBe(thread.revision);
    expect(savedThread.comments).toEqual([
      expect.objectContaining({
        id: submittedComment.id,
        revision: 1,
        body: submittedInlineFeedback,
      }),
    ]);
    const editedThread = await checked(
      admin.from("artifact_review_threads").select("*").eq("id", thread.id).single(),
    );
    expect(editedThread.revision).toBeGreaterThan(savedThread.thread_revision);
    const replayAfterEdits = await production.handleRejection(rejectInput);
    expect(replayAfterEdits.feedbackBatchId).toBe(rejection.feedbackBatchId);
    expect(replayAfterEdits.jobId).toBe(rejection.jobId);
    const savedInput = await production.loadPinnedSessionJobGitInput({
      admin,
      jobId: rejection.jobId,
      sessionId,
      workspaceId: ids.workspaceId,
    });
    expect(savedInput?.input_sha).toBe(buildSha);
    assert(savedInput?.input_ref);

    // A terminal failure followed by Retry Run creates a new job. It must
    // inherit the original immutable batch before entering the real processor.
    const terminalJob = await claimJob(admin, rejection.jobId);
    const initialFailedRunId = await rpc<string>(admin, "start_session_job_attempt", {
      p_job_id: terminalJob.id,
      p_attempt_count: terminalJob.attempt_count,
      p_expected_stage_id: reviewedBeforeComments.current_stage_id,
      p_expected_artifact_version: reviewedArtifact.version,
      p_model_provider: "codex",
      p_model_name: "gpt-5.5",
      p_run_type: "project",
      p_branch_name: "wallie/controlled-terminal-feedback-failure",
    });
    assert(initialFailedRunId);
    expect(
      await rpc(admin, "fail_session_job_attempt", {
        p_job_id: terminalJob.id,
        p_attempt_count: terminalJob.attempt_count,
        p_run_id: initialFailedRunId,
        p_error: "Controlled terminal feedback failure",
        p_retry: false,
        p_max_retries: 1,
      }),
    ).toBe("error");
    const manualReceipts = await rpc<Array<{ job_id: string; run_id: string }>>(
      admin,
      "enqueue_session_job_with_run",
      {
        p_session_id: sessionId,
        p_workspace_id: ids.workspaceId,
        p_expected_stage_id: reviewedBeforeComments.current_stage_id,
        p_requested_by_member_id: ids.memberId,
        p_trigger_type: "manual_retry",
        p_agent_model_provider: "codex",
        p_agent_model_name: "gpt-5.5",
        p_run_type: "project",
      },
    );
    const manualRetryJobId = manualReceipts[0]?.job_id;
    assert(manualRetryJobId && manualRetryJobId !== rejection.jobId);

    // An old worker loses its actual database claim while its runner is paused.
    phase = "stale";
    const oldJob = await claimJob(admin, manualRetryJobId);
    const pendingOldWorker = production.processPipelineJob({ admin, job: oldJob });
    staleWorker = pendingOldWorker;
    const oldExecution = await Promise.race([
      staleStarted.promise,
      pendingOldWorker.then(() => {
        throw new Error("Old worker completed before reaching the replacement barrier.");
      }),
    ]);
    expect(
      await checked(
        admin
          .from("artifact_feedback_batch_jobs")
          .select("batch_id")
          .eq("job_id", oldJob.id)
          .eq("workspace_id", ids.workspaceId)
          .eq("session_id", sessionId)
          .single(),
      ),
    ).toEqual({ batch_id: rejection.feedbackBatchId });
    expect(
      await rpc(admin, "fail_stalled_session_job_attempt", {
        p_job_id: oldJob.id,
        p_attempt_count: oldJob.attempt_count,
        p_run_id: oldExecution.runId,
        p_error: "Controlled worker replacement",
        p_retry: true,
        p_max_retries: 3,
      }),
    ).toBe("queued");
    const queued = await checked(admin.from("agent_jobs").select("*").eq("id", oldJob.id).single());
    await dueAt(queued.scheduled_at);
    phase = "revision";
    const restartedAdmin = adminClient();
    const newJob = await claimJob(restartedAdmin, oldJob.id);
    expect(newJob.attempt_count).toBe(oldJob.attempt_count + 1);
    const revised = await production.processPipelineJob({ admin: restartedAdmin, job: newJob });
    expect(revised.result).toBe("success");
    const revisedCheckpoint = await checkpoint(revised.runId!);
    expect(revisedCheckpoint.input_sha).toBe(buildSha);
    const cursorBeforeLateWorker = await checked(
      admin.from("session_git_heads").select("*").eq("session_id", sessionId).single(),
    );
    const revisedEpoch = await canonical();
    expect(revisedEpoch.id).toBe(firstEpoch.id);
    const canonicalBeforeLateWorker = await git(
      remote,
      "rev-parse",
      `refs/heads/${firstEpoch.branch_name}`,
    );
    staleRelease.resolve();
    expect(await staleWorker).toMatchObject({ result: "idle" });
    staleWorker = undefined;
    expect(
      await checked(
        admin.from("session_git_heads").select("*").eq("session_id", sessionId).single(),
      ),
    ).toEqual(cursorBeforeLateWorker);
    expect(await git(remote, "rev-parse", `refs/heads/${firstEpoch.branch_name}`)).toBe(
      canonicalBeforeLateWorker,
    );
    expect(
      await checked(
        admin.from("session_git_checkpoints").select("run_id").eq("run_id", oldExecution.runId),
      ),
    ).toEqual([]);
    expect(existsSync(oldExecution.sandboxPath)).toBe(false);
    expect(transport.createCount).toBe(1);

    // A genuinely new Node/Vitest worker receives no in-memory sandbox state.
    const verifyJobId = await approve();
    const selected = await production.loadPinnedSessionJobGitInput({
      admin,
      jobId: verifyJobId,
      sessionId,
      workspaceId: ids.workspaceId,
    });
    expect(selected?.input_sha).toBe(revisedCheckpoint.output_sha);
    const outputPath = join(root, "restarted-worker-result.json");
    const manifest: Manifest = {
      root,
      remote,
      repositoryName,
      repositoryNumericId,
      workspaceId: ids.workspaceId,
      sessionId,
      jobId: verifyJobId,
      expectedSha: revisedCheckpoint.output_sha,
      expectedFiles: {
        "src/original.ts": originalCode,
        "src/plan.ts": planCode,
        "src/feature.ts": revisedCode,
        "src/revision.ts": "export const revision = 2;\n",
      },
      outputPath,
    };
    const manifestPath = join(root, "restart-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await exec(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "test/release/restart.worker.fixture.ts",
        "--config",
        "vitest.continuity.config.ts",
      ],
      {
        env: { ...process.env, WALLIE_CONTINUITY_RESTART_MANIFEST: manifestPath },
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const restarted = JSON.parse(await readFile(outputPath, "utf8")) as {
      pid: number;
      inputSha: string;
      outputSha: string;
      outputKind: string;
    };
    expect(restarted.pid).not.toBe(process.pid);
    expect(restarted.inputSha).toBe(revisedCheckpoint.output_sha);
    expect(restarted.outputSha).toBe(revisedCheckpoint.output_sha);
    expect(restarted.outputKind).toBe("no-code");
    expect((await canonical()).id).toBe(firstEpoch.id);
    expect(await git(remote, "show", `${revisedCheckpoint.output_sha}:src/original.ts`)).toBe(
      originalCode.trim(),
    );
    expect(await git(remote, "show", `${revisedCheckpoint.output_sha}:src/feature.ts`)).toBe(
      revisedCode.trim(),
    );
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(movedMain);
    expect(transport.createCount).toBe(1);
    expect((await session()).phase_status).toBe("awaiting_review");
    const lineage = await checked(
      admin
        .from("session_git_checkpoints")
        .select(
          "run_id,job_id,attempt_count,artifact_id,input_sha,output_sha,output_ref,output_kind,initial_base_sha",
        )
        .eq("session_id", sessionId)
        .eq("workspace_id", ids.workspaceId)
        .order("created_at"),
    );
    expect(lineage.map((row) => row.input_sha)).toEqual([
      baseSha,
      planSha,
      buildSha,
      revisedCheckpoint.output_sha,
    ]);
    expect(lineage.map((row) => row.output_sha)).toEqual([
      planSha,
      buildSha,
      revisedCheckpoint.output_sha,
      revisedCheckpoint.output_sha,
    ]);
    expect(lineage.every((row) => row.initial_base_sha === baseSha)).toBe(true);
    const artifacts = await checked(
      admin
        .from("session_artifacts")
        .select("id,stage_slug,version")
        .eq("session_id", sessionId)
        .eq("workspace_id", ids.workspaceId),
    );
    evidence = {
      schemaVersion: 1,
      fixture: "local-fake-provider-with-real-database-and-git",
      verifiedAt: new Date().toISOString(),
      workspaceId: ids.workspaceId,
      sessionId,
      repository: {
        connectionId: ids.repositoryId,
        numericId: repositoryNumericId,
        fullName: repositoryName,
      },
      initialBaseSha: baseSha,
      movingDefaultSha: movedMain,
      checkpoints: lineage.map((row) => ({
        ...row,
        stage: artifacts.find((artifact) => artifact.id === row.artifact_id)?.stage_slug,
        artifactVersion: artifacts.find((artifact) => artifact.id === row.artifact_id)?.version,
      })),
      canonicalPullRequest: {
        transport: "in-process-fake",
        epochId: firstEpoch.id,
        number: firstEpoch.pr_number,
        branch: firstEpoch.branch_name,
        headSha: canonicalBeforeLateWorker,
        fenceSha: await git(remote, "rev-parse", `refs/heads/${firstEpoch.fence_branch}`),
      },
      restart: {
        parentPid: process.pid,
        workerPid: restarted.pid,
        inputSha: restarted.inputSha,
        outputSha: restarted.outputSha,
        outputKind: restarted.outputKind,
      },
      feedbackBatch: {
        manualRetryJobId,
        initialFailedRunId,
        id: savedBatch.id,
        jobId: savedBatch.job_id,
        checkpointRunId: savedBatch.checkpoint_run_id,
        reviewedArtifactId: savedBatch.artifact_id,
        reviewRevision: savedBatch.review_revision,
        threadId: savedThread.thread_id,
        submittedThreadRevision: savedThread.thread_revision,
        commentsImmutable: true,
        laterEditAndReplyRemainUnsent: true,
        networkRetrySameGeneration: true,
      },
      staleWorker: {
        runId: oldExecution.runId,
        attemptCount: oldJob.attempt_count,
        replacementRunId: revised.runId,
        acceptedCheckpoint: false,
        cursorUnchanged: true,
        canonicalHeadUnchanged: true,
      },
      releasePause: {
        capturedCheckpointRecoveredWhilePaused: true,
        canonicalPublicationWaitedForResume: true,
      },
      cleanup: { completed: false },
    };
    await persistEvidence();
    console.log("[continuity-release] verified", {
      stages: ["plan", "build", "revised-build", "verify"],
      pullRequests: 1,
      subprocessRestart: true,
      staleWorkerFenced: true,
      capturedRecoveryWhilePaused: true,
      immutableInlineFeedback: true,
    });
  } finally {
    staleRelease?.resolve();
    await staleWorker?.catch(() => undefined);
    await stopSandboxes?.();
    try {
      const restored = await setRelease(
        admin,
        priorRelease.enabled,
        priorRelease.reason || "Restore prior local release state",
      );
      expect(restored.enabled).toBe(priorRelease.enabled);
      expect(restored.reason).toBe(priorRelease.reason || "Restore prior local release state");
    } finally {
      try {
        await signOutReviewer?.();
        if (userId) await cleanupLocalFixture(admin, { workspaceId: ids.workspaceId, userId });
      } finally {
        vi.unstubAllGlobals();
        await rm(root, { recursive: true, force: true });
      }
    }
    if (evidence) {
      evidence.cleanup = {
        completed: true,
        releaseEnabledRestoredTo: priorRelease.enabled,
        fixtureWorkspaceRemoved: true,
        fixtureStorageRemoved: true,
        localSandboxesRemoved: true,
      };
      await persistEvidence();
    }
  }
});
