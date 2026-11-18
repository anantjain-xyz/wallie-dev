import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { loadRunTranscript } from "@/features/wallie/run-transcript";
import { loadRunAgentPrompt } from "@/lib/factory-agents/runtime";
import { loadFactorySkillBundle } from "@/lib/factory-skills/runtime";
import {
  loadPinnedFactoryExecution,
  loadPinnedSessionPrompt,
} from "@/lib/factory-definitions/runtime-definition";
import { pinSessionAttemptManifest } from "@/lib/pipeline/attempt-manifest";
import { drainCheckpointPublications } from "@/lib/pipeline/checkpoint-publication";
import { processPipelineJob } from "@/lib/pipeline/processor";
import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { RunEventCapture } from "@/lib/pipeline/run-events";
import { loadAttemptPredecessors } from "@/lib/pipeline/stages";
import { renderStagePrompt } from "@/lib/prompt-templates";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import {
  assertPublishedRunHistory,
  completedRunEvent,
  initialRunEvent,
  reconnectRunEvent,
} from "../../test/release/run-history-fixture";
import type { Env } from "../index";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/lib/pipeline/processor", async (original) => ({
  ...(await original<typeof import("@/lib/pipeline/processor")>()),
  processPipelineJob: vi.fn(),
}));

const bindings = env as unknown as Env;
const fixtureSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => {
      const localUrl = new URL(url);
      return (
        localUrl.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(localUrl.hostname)
      );
    }),
  serviceKey: z.string().min(1),
  reviewerToken: z.string().min(1),
  workspaceId: z.string().uuid(),
  workspaceSlug: z.string().min(1),
  sessionId: z.string().uuid(),
  stageId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  jobId: z.string().uuid(),
  attemptCount: z.number().int().positive(),
  workflowId: z.string().min(1),
  definitionRevisionId: z.string().uuid(),
  definitionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  modelName: z.string().min(1),
  agentId: z.string().uuid(),
  agentPromptRevisionId: z.string().uuid(),
  agentPrompt: z.string(),
  skillRevisionId: z.string().uuid(),
  skillContent: z.string(),
});

async function checked<T>(request: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

it.skipIf(!bindings.WALLIE_NATIVE_HISTORY_FIXTURE)(
  "preserves the same authenticated retained history after real Workflow replay in workerd",
  async () => {
    // The effective client always talks to the explicitly isolated Supabase stack.
    // Only external agent execution is replaced. Dispatch, recovery, and publication
    // call the real database through the native worker runtime.
    const fixture = fixtureSchema.parse(
      JSON.parse(z.string().parse(bindings.WALLIE_NATIVE_HISTORY_FIXTURE)),
    );
    const admin = createClient<Database>(fixture.url, fixture.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const reviewer = createClient<Database>(fixture.url, fixture.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${fixture.reviewerToken}` } },
    });
    vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
    const rpc = vi.spyOn(admin, "rpc");
    vi.mocked(processPipelineJob).mockImplementationOnce(
      async ({ admin: worker, job, deadlineAt, captureOrderedEvents, workerRuntime }) => {
        assert.equal(worker, admin);
        assert.equal(job.id, fixture.jobId);
        assert.equal(job.attempt_count, fixture.attemptCount);
        assert.equal(captureOrderedEvents, true);
        assert.equal(workerRuntime, "workerd");
        const session = await checked(
          worker.from("sessions").select("*").eq("id", fixture.sessionId).single(),
        );
        assert(session);
        expect(session.factory_definition_revision_id).toBe(fixture.definitionRevisionId);
        const [definition, sourcePrompt, predecessors] = await Promise.all([
          loadPinnedFactoryExecution(worker, session),
          loadPinnedSessionPrompt(worker, session),
          loadAttemptPredecessors(worker, session.id),
        ]);
        assert(definition);
        expect(definition.canonicalDigest).toBe(fixture.definitionDigest);
        expect(definition.agent.model).toBe(fixture.modelName);
        const stage = definition.stages[0];
        expect(stage.id).toBe(fixture.stageId);
        expect(predecessors.predecessors).toEqual([]);
        const runId = await checked(
          worker.rpc("start_session_job_attempt", {
            p_job_id: job.id,
            p_attempt_count: job.attempt_count,
            p_expected_stage_id: fixture.stageId,
            p_expected_artifact_version: 0,
            p_model_provider: definition.agent.provider,
            p_model_name: definition.agent.model,
            p_run_type: "project",
            p_branch_name: `wallie/native-retained-history/${job.id}`,
          }),
        );
        assert(runId);
        const agentPrompt = await loadRunAgentPrompt(worker, {
          workspaceId: session.workspace_id,
          factoryId: session.factory_id,
          sessionId: session.id,
          runId,
          expected: definition.implementationAgent,
        });
        expect(agentPrompt.agentId).toBe(fixture.agentId);
        expect(agentPrompt.promptRevisionId).toBe(fixture.agentPromptRevisionId);
        expect(definition.skillIds).toEqual([fixture.skillRevisionId]);
        const skillInstructions = await loadFactorySkillBundle(worker, {
          workspaceId: session.workspace_id,
          factoryId: session.factory_id,
          skillRevisionIds: definition.skillIds,
        });
        const prompt = renderStagePrompt(
          {
            promptTemplateMd: trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd),
            slug: trustedPromptValue("stage.slug", stage.slug),
          },
          {
            agentPromptMd: trustedPromptValue("agent.prompt", agentPrompt.promptMd),
            skillInstructions,
            attemptFeedback: null,
            attemptNumber: 1,
            operatingRulesMd: trustedPromptValue(
              "pipeline.operatingRules",
              definition.operatingRulesMd,
            ),
            sessionPrompt: untrustedPromptValue("session.prompt", sourcePrompt.promptMd),
            sessionTitle: untrustedPromptValue("session.title", sourcePrompt.title),
          },
        );
        expect(prompt).toContain("Published replacement template 1");
        expect(prompt).toContain("Native Workflow pinned replacement");
        expect(prompt).toContain("Published replacement operating rules");
        expect(prompt.startsWith(fixture.agentPrompt)).toBe(true);
        expect(prompt).toContain(fixture.skillContent);
        const pinned = await checked(
          worker.rpc("pin_session_job_git_input", {
            p_job_id: job.id,
            p_attempt_count: job.attempt_count,
            p_run_id: runId,
            p_repository_id: fixture.repositoryId,
            p_base_branch: "main",
            p_observed_sha: fixture.baseSha,
          }),
        );
        assert.equal(pinned?.[0]?.input_sha, fixture.baseSha);
        expect(
          await pinSessionAttemptManifest({
            admin: worker,
            jobId: job.id,
            runId,
            attemptCount: job.attempt_count,
            prompt,
            checkoutSha: fixture.baseSha,
            predecessors: predecessors.predecessors,
            workerRuntime,
            credentialOwnerMemberId: session.creator_member_id,
          }),
        ).toBe(true);
        const capture = new RunEventCapture(
          worker,
          {
            jobId: job.id,
            runId,
            attemptCount: job.attempt_count,
          },
          captureOrderedEvents,
        );
        capture.start("codex");
        for (const event of [initialRunEvent, reconnectRunEvent, completedRunEvent])
          await capture.record(event);
        await capture.finish("complete");
        const prepared = await checked(
          worker.rpc("prepare_session_source_and_checkpoint_publication", {
            p_run_id: runId,
            p_repository_id: fixture.repositoryId,
            p_base_branch: "main",
            p_base_sha: fixture.baseSha,
            p_head_sha: fixture.baseSha,
            p_title: "Native retained-history fixture",
            p_body: completedRunEvent.finalOutput,
            p_checkpoint_path: "",
            p_bundle_sha256: "",
            p_bundle_base64: "",
            p_expected_artifact_version: 0,
            p_artifact_md: completedRunEvent.finalOutput,
            p_deadline_at: deadlineAt,
            p_input_tokens: completedRunEvent.usage.inputTokens,
            p_output_tokens: completedRunEvent.usage.outputTokens,
          }),
        );
        assert.equal(prepared, true);
        throw new Error("Fixture lost the preparation response after commit.");
      },
    );

    const attempt = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, fixture.workflowId);
    try {
      const instance = await bindings.SESSION_ATTEMPT.create({
        id: fixture.workflowId,
        params: {
          jobId: fixture.jobId,
          attemptCount: fixture.attemptCount,
          workflowId: fixture.workflowId,
        },
      });
      await attempt.waitForStatus("complete");
      expect(processPipelineJob).toHaveBeenCalledOnce();
      expect(processPipelineJob).toHaveBeenCalledWith(
        expect.objectContaining({ workerRuntime: "workerd" }),
      );
      const owned = await checked(
        admin
          .from("agent_runs")
          .select("id,status")
          .eq("agent_job_id", fixture.jobId)
          .eq("attempt_count", fixture.attemptCount)
          .maybeSingle(),
      );
      assert(owned, "The native Workflow did not claim the expected run attempt.");
      const scope = { ...fixture, runId: owned.id };
      expect(owned.status).toBe("running");
      const captured = await loadRunTranscript({ supabase: reviewer, ...scope });
      expect(captured?.runStatus).toBe("running");
      expect(captured?.entries.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
      const interrupted = await checked(
        admin
          .from("session_checkpoint_publications")
          .select("status,deadline_at")
          .eq("run_id", scope.runId)
          .single(),
      );
      expect(interrupted?.status).toBe("pending");

      const recoveryCalls = () =>
        rpc.mock.calls.filter(([name]) => name === "fail_stalled_session_job_attempt").length;
      const before = recoveryCalls();
      await instance.restart();
      await vi.waitFor(() => expect(recoveryCalls()).toBeGreaterThan(before), { timeout: 10_000 });
      await attempt.waitForStatus("complete");
      expect(processPipelineJob).toHaveBeenCalledOnce();

      expect(await drainCheckpointPublications(admin, { runId: scope.runId, limit: 1 })).toEqual({
        adopted: 1,
        failed: 0,
      });
      expect(await drainCheckpointPublications(admin, { runId: scope.runId, limit: 1 })).toEqual({
        adopted: 0,
        failed: 0,
      });
      const acceptance = await checked(
        admin
          .from("session_checkpoint_publications")
          .select("status,deadline_at")
          .eq("run_id", scope.runId)
          .single(),
      );
      expect(acceptance).toEqual({ status: "adopted", deadline_at: interrupted?.deadline_at });
      const output = await checked(
        admin
          .from("session_git_checkpoints")
          .select("artifact_id,output_sha,output_kind")
          .eq("run_id", scope.runId)
          .single(),
      );
      assert(output);
      expect(output.output_kind).toBe("no-code");
      expect(output.output_sha).toBe(fixture.baseSha);
      await assertPublishedRunHistory(reviewer, scope, {
        artifactId: output.artifact_id,
        checkpointSha: output.output_sha,
      });
      expect(
        await checked(
          admin
            .from("session_artifacts")
            .select("id")
            .eq("workspace_id", fixture.workspaceId)
            .eq("session_id", fixture.sessionId),
        ),
      ).toEqual([{ id: output.artifact_id }]);
    } finally {
      await attempt.dispose();
      rpc.mockRestore();
    }
  },
  40_000,
);
