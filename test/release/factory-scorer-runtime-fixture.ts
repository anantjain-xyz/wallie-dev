import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { evaluationReceiptPageSchema } from "@/lib/factory-evaluations/evaluation-receipt-contracts";
import { scoreTrendSchema } from "@/lib/factory-evaluations/score-trend-contracts";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { BASE_SHA, type FactoryRuntimeTransport } from "./factory-runtime-transport";

export const SCORER_FIXTURE_JUDGE_MODEL = "openai/gpt-4.1-mini";
export const SCORER_FIXTURE_JUDGE_PROVIDER = "openai";
export const SCORER_FIXTURE_JUDGE_KEY = "synthetic-local-openrouter-key";

const scorerName = "Qualification artifact review";
const scoredArtifact =
  "# Qualification scored output\n\nThe exact retained output passed the fixture rubric.";
const originalRubric = {
  schemaVersion: 1,
  rubric: "Confirm that the retained artifact describes the published qualification result.",
  requiredEvidence: ["artifact"],
  scoring: { kind: "boolean", passValue: true },
} satisfies FactoryScorerDefinition;
const revisedRubric = {
  ...originalRubric,
  rubric: "Confirm that the retained artifact explicitly names the revised qualification.",
} satisfies FactoryScorerDefinition;

export type FactoryScorerExpectedJudgeInput = {
  rubric: string;
  artifactId: string;
  artifact: string;
};

export type FactoryScorerFixtureJudge = {
  respond(
    input: FactoryScorerExpectedJudgeInput,
    outcome: "unavailable" | "pass",
    beforeResponse?: () => Promise<void>,
  ): () => void;
  requestCount(): number;
};

export type FactoryScorerBrowserFixture = {
  owner: { email: string; password: string };
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  scorerId: string;
  oldRevisionId: string;
  newRevisionId: string;
  oldPolicyId: string;
  newPolicyId: string;
  scoredRunId: string;
  scoredJobId: string;
  scoredAttemptId: string;
  scoredArtifactId: string;
  sessionId: string;
  canceledRunId: string;
  canceledJobId: string;
  canceledAttemptId: string;
  canceledSessionId: string;
  cohort: { from: string; to: string; snapshot: string };
};

export type FactoryScorerRuntimeMode = {
  maintain: () => Promise<void>;
  judge: FactoryScorerFixtureJudge;
  inspectScore?: (fixture: FactoryScorerBrowserFixture) => Promise<void>;
};

type Client = SupabaseClient<Database>;
type Job = { job_id: string; run_id: string; session_id: string };
type ScorerFixture = FactoryScorerRuntimeMode & {
  admin: Client;
  viewer: Client;
  runtime: "node" | "workerd";
  transport: FactoryRuntimeTransport;
  workspace: {
    workspaceId: string;
    factoryId: string;
    actorId: string;
    memberId: string;
    slug: string;
    stage: { id: string };
  };
  owner: FactoryScorerBrowserFixture["owner"];
  activate: (scorerRevisionId: string, offset: 0 | 1) => Promise<{ id: string }>;
  admit: (title: string) => Promise<Job>;
  execute: (job: Job) => Promise<void>;
};

async function checked<T>(
  request: PromiseLike<{ data: T; error: { message: string } | null }>,
  operation: string,
): Promise<NonNullable<T>> {
  const { data, error } = await request;
  assert(
    !error && data !== null && data !== undefined,
    error ? `${operation}: ${error.message}` : operation,
  );
  return data;
}

function cohortWindow() {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 2);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function qualifyFactoryScorerRuntime({
  admin,
  viewer,
  runtime,
  transport,
  workspace,
  owner,
  activate,
  admit,
  execute,
  maintain,
  judge,
  inspectScore,
}: ScorerFixture) {
  const note = (stage: string) => console.log(`[factory-scorer-qualification:${runtime}] ${stage}`);
  const scope = { p_workspace_id: workspace.workspaceId, p_factory_id: workspace.factoryId };
  const actor = { ...scope, p_actor_user_id: workspace.actorId };
  const window = cohortWindow();
  const requestsBefore = judge.requestCount();

  const profile = await checked(
    admin.rpc("configure_factory_judge_profile", {
      p_workspace_id: workspace.workspaceId,
      p_actor_user_id: workspace.actorId,
      p_expected_revision: 0,
      p_model_id: SCORER_FIXTURE_JUDGE_MODEL,
      p_provider_route: SCORER_FIXTURE_JUDGE_PROVIDER,
      p_allow_images: false,
      p_allow_video: false,
      p_encrypted_api_key: encryptSecretValue(SCORER_FIXTURE_JUDGE_KEY),
    }),
    "approve the scoped fixture judge",
  );
  assert(profile.enabled);

  async function enroll(revisionId: string, offset: 0 | 1) {
    const revision = await activate(revisionId, offset);
    const policy = await checked(
      admin.rpc("save_factory_scorer_sampling_policy", {
        ...actor,
        p_scorer_revision_id: revisionId,
        p_expected_revision: 0,
        p_rate_bps: 10_000,
        p_seed: "factory-runtime-scorer-qualification",
        p_stage_ids: [workspace.stage.id],
        p_terminal_statuses: ["success"],
      }),
      "enroll this exact scorer revision and stage",
    );
    return { revision, policy };
  }

  async function publish(title: string, artifact: string, definitionId: string) {
    const job = await admit(title);
    transport.completeAttempt(job.run_id, { artifact });
    await execute(job);
    const [current, terminal, run] = await Promise.all([
      checked(
        admin
          .from("sessions")
          .select(
            "phase_status,current_stage_id,current_artifact_id,current_artifact_version,artifact_review_revision,factory_definition_revision_id",
          )
          .eq("id", job.session_id)
          .eq("workspace_id", workspace.workspaceId)
          .single(),
        "read the exact production review",
      ),
      checked(
        admin.from("agent_jobs").select("status,last_error").eq("id", job.job_id).single(),
        "read the exact production job",
      ),
      checked(
        admin
          .from("agent_runs")
          .select("status,attempt_count,finished_at,model_provider,model_name")
          .eq("id", job.run_id)
          .eq("workspace_id", workspace.workspaceId)
          .single(),
        "read the exact production run",
      ),
    ]);
    assert.equal(terminal.status, "success", terminal.last_error ?? "Production did not publish.");
    assert.equal(run.status, "success");
    assert(run.attempt_count && run.attempt_count > 0, "Production must have an owning attempt.");
    assert(run.finished_at && run.model_provider && run.model_name);
    assert.equal(current.phase_status, "awaiting_review");
    assert.equal(current.current_stage_id, workspace.stage.id);
    assert.equal(current.factory_definition_revision_id, definitionId);
    assert(current.current_artifact_id && current.current_artifact_version > 0);
    const checkpoint = await checked(
      admin
        .from("session_git_checkpoints")
        .select("input_sha,output_sha,artifact_id,attempt_count")
        .eq("run_id", job.run_id)
        .eq("workspace_id", workspace.workspaceId)
        .eq("session_id", job.session_id)
        .eq("job_id", job.job_id)
        .eq("attempt_count", run.attempt_count)
        .single(),
      "read the accepted source checkpoint",
    );
    assert.equal(checkpoint.artifact_id, current.current_artifact_id);
    assert.equal(checkpoint.attempt_count, run.attempt_count);
    assert.equal(checkpoint.input_sha, BASE_SHA);
    assert.equal(checkpoint.output_sha, BASE_SHA);
    return { job, current, checkpoint, run, artifact };
  }

  async function readEvaluation(runId: string, scorerRevisionId: string) {
    return checked(
      admin
        .from("factory_evaluation_jobs")
        .select("id,status,attempt_count,scorer_revision_id,sample_receipt_id,target_commit_sha")
        .eq("workspace_id", workspace.workspaceId)
        .eq("factory_id", workspace.factoryId)
        .eq("run_id", runId)
        .eq("scorer_revision_id", scorerRevisionId)
        .is("source_attempt_id", null)
        .single(),
      "read the single logical automatic evaluation",
    );
  }

  async function readReceipt(jobId: string) {
    const page = evaluationReceiptPageSchema.parse(
      await checked(
        admin.rpc("list_factory_evaluation_receipts", { ...actor, p_job_id: jobId }),
        "read the immutable exact evaluation receipt",
      ),
    );
    assert.equal(page.receipts.length, 1);
    const [receipt] = page.receipts;
    assert(receipt);
    return receipt;
  }

  async function readCohort(policyId: string, snapshot?: string) {
    return scoreTrendSchema.parse(
      await checked(
        viewer.rpc("read_factory_score_cohort", {
          ...scope,
          p_policy_id: policyId,
          p_from: window.from,
          p_to: window.to,
          ...(snapshot ? { p_snapshot: snapshot } : {}),
        }),
        "read the signed scorer cohort as a factory viewer",
      ),
    );
  }

  async function evaluatePublication(
    publication: Awaited<ReturnType<typeof publish>>,
    rubric: string,
    outcome: "unavailable" | "pass",
    beforeResponse?: () => Promise<void>,
  ) {
    const verify = judge.respond(
      { rubric, artifactId: publication.checkpoint.artifact_id, artifact: publication.artifact },
      outcome,
      beforeResponse,
    );
    await maintain();
    verify();
  }

  const original = await checked(
    admin.rpc("create_factory_scorer", {
      ...actor,
      p_name: scorerName,
      p_slug: "qualification-artifact-review",
      p_definition: originalRubric,
    }),
    "create the original fixture rubric",
  );
  const originalEnrollment = await enroll(original.id, 0);
  const scored = await publish(
    "Publish the scored qualification artifact",
    scoredArtifact,
    originalEnrollment.revision.id,
  );
  note("published the exact production artifact");
  await evaluatePublication(scored, originalRubric.rubric, "pass");
  const logical = await readEvaluation(scored.job.run_id, original.id);
  const scoredReceipt = await readReceipt(logical.id);
  assert.equal(
    logical.status,
    "succeeded",
    `The first evaluation settled as ${scoredReceipt.status} (${scoredReceipt.reason ?? "no reason"}).`,
  );
  assert.equal(judge.requestCount(), requestsBefore + 1);
  assert.equal(logical.attempt_count, 1);
  assert.equal(logical.target_commit_sha, scored.checkpoint.output_sha);
  assert.equal(scoredReceipt.worker_runtime, runtime);
  assert.equal(scoredReceipt.adapter_runtime, "openrouter-chat-v1");
  assert.equal(scoredReceipt.profile_revision_id, profile.id);
  assert.equal(scoredReceipt.provider_model, SCORER_FIXTURE_JUDGE_MODEL);
  assert.equal(scoredReceipt.run_id, scored.job.run_id);
  assert.equal(scoredReceipt.scorer_revision_id, original.id);
  assert.equal(scoredReceipt.target_commit_sha, scored.checkpoint.output_sha);
  assert.equal(scoredReceipt.sample_receipt_id, logical.sample_receipt_id);
  assert.equal(scoredReceipt.status, "pass");
  assert.deepEqual(scoredReceipt.score, { kind: "boolean", value: true });
  assert.equal(scoredReceipt.evidence_availability, "available");
  assert(scoredReceipt.evidence_digest && scoredReceipt.explanation);
  assert.deepEqual(scoredReceipt.evidence_locations, [
    {
      reference: { kind: "artifact", id: scored.checkpoint.artifact_id },
      location: { kind: "whole" },
    },
  ]);
  assert.equal(scoredReceipt.token_provenance, "measured");
  assert.equal(scoredReceipt.cost_provenance, "measured");

  const automaticSample = await checked(
    admin
      .from("factory_scorer_sample_receipts")
      .select("*")
      .eq("id", logical.sample_receipt_id)
      .single(),
    "read live membership before exact replay",
  );
  assert.equal(automaticSample.outcome, "sampled");
  assert.equal(automaticSample.policy_id, originalEnrollment.policy.id);
  assert.equal(automaticSample.definition_revision_id, originalEnrollment.revision.id);
  const recordedBefore = await readCohort(originalEnrollment.policy.id);
  assert.equal(recordedBefore.totals.candidate_count, 1);
  assert.equal(recordedBefore.totals.eligible_count, 1);
  assert.equal(recordedBefore.totals.sampled_count, 1);
  assert.equal(recordedBefore.totals.usable_count, 1);
  assert.equal(recordedBefore.totals.pass_count, 1);
  assert.equal(recordedBefore.rows[0]?.evaluation_attempt_id, scoredReceipt.attempt_id);
  for (let replay = 0; replay < 2; replay += 1) {
    const prior = await checked(
      admin.rpc("record_factory_scorer_sample", {
        ...scope,
        p_policy_id: originalEnrollment.policy.id,
        p_run_id: scored.job.run_id,
      }),
      "redeliver the same terminal run to the sampling consumer",
    );
    assert.deepEqual(prior, automaticSample);
  }
  await maintain();
  assert.equal(judge.requestCount(), requestsBefore + 1);
  assert.deepEqual(await readEvaluation(scored.job.run_id, original.id), logical);
  assert.deepEqual(await readReceipt(logical.id), scoredReceipt);
  assert.deepEqual((await readCohort(originalEnrollment.policy.id)).totals, recordedBefore.totals);
  note("evaluated once and replayed identical terminal input without duplicate scoring");

  const outage = await publish(
    "Approve during the scorer provider outage",
    "# Qualification approval during judge outage",
    originalEnrollment.revision.id,
  );
  await evaluatePublication(outage, originalRubric.rubric, "unavailable", async () => {
    const claimed = await readEvaluation(outage.job.run_id, original.id);
    assert.equal(claimed.status, "claimed");
    const { current, run } = outage;
    assert(current.current_artifact_id && run.model_provider && run.model_name);
    const approvalInput = {
      target_session_id: outage.job.session_id,
      expected_workspace_id: workspace.workspaceId,
      expected_stage_id: workspace.stage.id,
      expected_artifact_id: current.current_artifact_id,
      expected_version: current.current_artifact_version,
      approver_member_id: workspace.memberId,
      p_agent_model_provider: run.model_provider,
      p_agent_model_name: run.model_name,
      p_expected_review_revision: current.artifact_review_revision,
    };
    const stale = await admin.rpc("approve_session_stage", {
      ...approvalInput,
      p_expected_review_revision: current.artifact_review_revision + 1,
    });
    assert.equal(stale.error?.code, "PT412");
    const approval = await checked(
      admin.rpc("approve_session_stage", approvalInput),
      "approve the exact artifact while the judge request is held",
    );
    assert.equal(approval.length, 1);
    assert.equal(approval[0]?.phase_status, "approved");
    assert.equal(approval[0]?.job_created, false);
    const [receipt, retained] = await Promise.all([
      checked(
        admin
          .from("session_stage_approval_receipts")
          .select("artifact_id,artifact_version,artifact_digest,approved_by_member_id,stage_id")
          .eq("session_id", outage.job.session_id)
          .single(),
        "verify the exact human approval receipt",
      ),
      checked(
        admin
          .from("session_artifacts")
          .select("artifact_json")
          .eq("id", current.current_artifact_id)
          .single(),
        "verify the approved retained artifact bytes",
      ),
    ]);
    assert.equal(typeof retained.artifact_json, "string");
    assert.deepEqual(receipt, {
      artifact_id: current.current_artifact_id,
      artifact_version: current.current_artifact_version,
      artifact_digest: createHash("sha256").update(String(retained.artifact_json)).digest("hex"),
      approved_by_member_id: workspace.memberId,
      stage_id: workspace.stage.id,
    });
    assert.equal((await readEvaluation(outage.job.run_id, original.id)).status, "claimed");
  });

  const failedJob = await readEvaluation(outage.job.run_id, original.id);
  const failedReceipt = await readReceipt(failedJob.id);
  assert.equal(failedJob.status, "queued");
  assert.equal(failedReceipt.status, "error");
  assert.equal(failedReceipt.reason, "provider_unavailable");
  assert.equal(failedReceipt.attempt_outcome, "retryable_failure");
  const closedRetry = await checked(
    admin.rpc("cancel_factory_evaluation_job", { ...actor, p_job_id: failedJob.id }),
    "cancel the already-recorded retry without touching production review",
  );
  assert.equal(closedRetry.status, "canceled");
  assert.deepEqual(await readReceipt(failedJob.id), failedReceipt);
  const publishedDuringOutage = await checked(
    admin.from("sessions").select("phase_status").eq("id", outage.job.session_id).single(),
    "confirm judge failure did not undo human approval",
  );
  assert.equal(publishedDuringOutage.phase_status, "approved");
  assert.equal(judge.requestCount(), requestsBefore + 2);
  note("approved production during the held judge outage and retained the retry failure");

  const originalFrozen = await readCohort(originalEnrollment.policy.id);
  assert.equal(originalFrozen.totals.candidate_count, 2);
  assert.equal(originalFrozen.totals.sampled_count, 2);
  const revised = await checked(
    admin.rpc("save_factory_scorer_revision", {
      ...actor,
      p_scorer_id: original.scorer_id,
      p_expected_revision: original.revision_number,
      p_definition: revisedRubric,
    }),
    "publish a distinct immutable rubric revision",
  );
  assert.equal(revised.revision_number, original.revision_number + 1);
  assert.notEqual(revised.id, original.id);
  const revisedEnrollment = await enroll(revised.id, 1);
  const canceled = await publish(
    "Publish while canceling the revised scorer",
    "# Revised qualification while the judge is canceled",
    revisedEnrollment.revision.id,
  );
  let canceledReceiptId: string | undefined;
  await evaluatePublication(canceled, revisedRubric.rubric, "pass", async () => {
    const claimed = await readEvaluation(canceled.job.run_id, revised.id);
    assert.equal(claimed.status, "claimed");
    const settled = await checked(
      admin.rpc("cancel_factory_evaluation_job", { ...actor, p_job_id: claimed.id }),
      "cancel the exact active judge attempt before its response",
    );
    assert.equal(settled.status, "canceled");
    const receipt = await readReceipt(claimed.id);
    assert.equal(receipt.status, "skipped");
    assert.equal(receipt.reason, "canceled");
    canceledReceiptId = receipt.attempt_id;
  });

  const canceledJob = await readEvaluation(canceled.job.run_id, revised.id);
  const canceledReceipt = await readReceipt(canceledJob.id);
  assert.equal(canceledJob.attempt_count, 1);
  assert.equal(canceledJob.status, "canceled");
  assert.equal(canceledReceipt.attempt_id, canceledReceiptId);
  assert.equal(canceledReceipt.worker_runtime, runtime);
  assert.equal(canceledReceipt.scorer_revision_id, revised.id);
  assert.equal(canceledReceipt.attempt_outcome, "canceled");
  assert.equal(canceledReceipt.status, "skipped");
  assert.equal(canceledReceipt.reason, "canceled");
  assert.equal(canceledReceipt.score, null);
  assert.equal(canceledReceipt.token_provenance, "unavailable");
  assert.equal(judge.requestCount(), requestsBefore + 3);
  const liveReview = await checked(
    admin
      .from("sessions")
      .select("phase_status,current_artifact_id")
      .eq("id", canceled.job.session_id)
      .single(),
    "confirm scorer cancellation leaves the exact production review pending",
  );
  assert.equal(liveReview.phase_status, "awaiting_review");
  assert.equal(liveReview.current_artifact_id, canceled.current.current_artifact_id);

  const oldAfter = await readCohort(originalEnrollment.policy.id);
  assert.deepEqual(oldAfter.totals, originalFrozen.totals);
  assert.deepEqual(oldAfter.points, originalFrozen.points);
  assert.deepEqual(oldAfter.rows, originalFrozen.rows);
  assert.deepEqual(
    await readCohort(originalEnrollment.policy.id, originalFrozen.snapshot),
    originalFrozen,
  );
  assert.deepEqual(
    await readCohort(originalEnrollment.policy.id, recordedBefore.snapshot),
    recordedBefore,
  );
  assert.deepEqual(await readReceipt(logical.id), scoredReceipt);
  const newCohort = await readCohort(revisedEnrollment.policy.id);
  assert.equal(newCohort.totals.candidate_count, 1);
  assert.equal(newCohort.totals.sampled_count, 1);
  assert.equal(newCohort.totals.usable_count, 0);
  assert.equal(newCohort.totals.skipped_count, 1);
  assert.equal(newCohort.rows[0]?.evaluation_attempt_id, canceledReceipt.attempt_id);
  note("discarded the late result and preserved the original cohort and exact receipt");

  if (runtime === "node" && inspectScore) {
    await inspectScore({
      owner,
      workspaceId: workspace.workspaceId,
      workspaceSlug: workspace.slug,
      factoryId: workspace.factoryId,
      scorerId: original.scorer_id,
      oldRevisionId: original.id,
      newRevisionId: revised.id,
      oldPolicyId: originalEnrollment.policy.id,
      newPolicyId: revisedEnrollment.policy.id,
      scoredRunId: scored.job.run_id,
      scoredJobId: logical.id,
      scoredAttemptId: scoredReceipt.attempt_id,
      scoredArtifactId: scored.checkpoint.artifact_id,
      sessionId: scored.job.session_id,
      canceledRunId: canceled.job.run_id,
      canceledJobId: canceledJob.id,
      canceledAttemptId: canceledReceipt.attempt_id,
      canceledSessionId: canceled.job.session_id,
      cohort: { ...window, snapshot: originalFrozen.snapshot },
    });
  }
}
