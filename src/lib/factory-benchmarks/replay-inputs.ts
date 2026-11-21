import "server-only";

import { z } from "zod";

import { loadRunAgentPrompt } from "@/lib/factory-agents/runtime";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { loadFactorySkillBundle } from "@/lib/factory-skills/runtime";
import {
  MAX_SOURCE_CHECKPOINT_BYTES,
  SOURCE_CHECKPOINT_BUCKET,
} from "@/lib/pipeline/source-checkpoint";
import { STAGE_PROMPT_RENDERER_VERSION } from "@/lib/prompt-templates";
import { runContextManifestSchema } from "@/lib/run-context/contracts";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

import { resolveBenchmarkCapture } from "./capture";
import {
  loadBenchmarkSource,
  readConnectedRepository,
  verifyBenchmarkRepositoryInput,
  type BenchmarkSourceScope,
} from "./capture-evidence";
import { readRequiredRunInputs } from "./capture-required";
import { readReplayContext } from "./replay-context";
import {
  BenchmarkReplayUnavailable,
  replayCandidateSchema,
  replayCommitSchema,
  replayDigestSchema,
  replaySha256,
  type ReplayCandidate,
  type ReplayLimit,
  type ReplayPlan,
  type ReplayRuntime,
} from "./replay-contracts";

const uuid = z.string().uuid();
const snapshotSchema = z.object({
  source_job_id: uuid,
  source_attempt_count: z.number().int().positive(),
  repository_id: uuid,
  input_sha: replayCommitSchema,
  input_ref: z.string().min(1).nullable(),
  checkout_sha: replayCommitSchema,
  source_checkpoint_run_id: uuid.nullable(),
  retry_source_run_id: uuid.nullable(),
  retry_bundle_sha256: replayDigestSchema.nullable(),
  definition_revision_id: uuid,
  definition_digest: replayDigestSchema,
  original_prompt_sha256: replayDigestSchema,
  rendered_prompt_sha256: replayDigestSchema,
  renderer_version: z.number().int().positive(),
  context_origin_run_id: uuid.nullable(),
  context_manifest_sha256: replayDigestSchema,
});
const runtimeSchema = z.enum(["node", "workerd"]);
type Scope = BenchmarkSourceScope;
type Snapshot = z.infer<typeof snapshotSchema>;

type BenchmarkReplayPrincipal = {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  actorUserId: string;
};

type BenchmarkReplayInput = (
  | { access: WorkspaceAccessContext }
  | { principal: BenchmarkReplayPrincipal }
) & {
  factoryId: string;
  taskRevisionId: string;
  candidate?: ReplayCandidate;
  signal: AbortSignal;
};

async function authorizeReplay(
  access: WorkspaceAccessContext,
  factoryId: string,
  sourceRunId: string,
  taskRevisionId: string,
) {
  const [workspace, member] = await Promise.all([
    access.supabase
      .from("workspaces")
      .select("deletion_requested_at")
      .eq("id", access.workspace.id)
      .maybeSingle(),
    access.supabase
      .from("workspace_members")
      .select("id, is_active, kind, role")
      .eq("workspace_id", access.workspace.id)
      .eq("user_id", access.user.id)
      .maybeSingle(),
  ]);
  if (
    workspace.error ||
    member.error ||
    !workspace.data ||
    workspace.data.deletion_requested_at ||
    !member.data?.is_active ||
    member.data.kind !== "human"
  ) {
    throw new BenchmarkReplayUnavailable("Current workspace access is unavailable.");
  }
  const scope = await resolveBenchmarkCapture(
    { ...access, currentMember: member.data },
    sourceRunId,
  );
  if (scope.factoryId !== factoryId)
    throw new BenchmarkReplayUnavailable("The source run is outside this factory.");
  const erasure = await access.supabase.rpc("get_session_retained_content_erasure", {
    target_workspace_id: access.workspace.id,
    target_session_id: scope.run.session_id,
  });
  if (erasure.error || erasure.data?.session_id) {
    throw new BenchmarkReplayUnavailable("The source session's retained inputs are unavailable.");
  }
  const allowed = await scope.admin.rpc("assert_factory_benchmark_replay_access", {
    p_workspace_id: access.workspace.id,
    p_factory_id: factoryId,
    p_actor_user_id: access.user.id,
    p_task_revision_id: taskRevisionId,
  });
  if (allowed.error || !allowed.data)
    throw new BenchmarkReplayUnavailable(
      "The original benchmark execution scope is no longer authorized.",
    );
  return scope;
}

async function authorizeWorkerReplay(
  principal: BenchmarkReplayPrincipal,
  factoryId: string,
  sourceRunId: string,
  taskRevisionId: string,
  signal: AbortSignal,
): Promise<Scope> {
  const { admin, workspaceId, actorUserId } = principal;
  const authority = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_task_revision_id: taskRevisionId,
  };
  const allowed = await admin
    .rpc("assert_factory_benchmark_replay_access", authority)
    .abortSignal(signal);
  signal.throwIfAborted();
  if (allowed.error || !allowed.data)
    throw new BenchmarkReplayUnavailable(
      "The original benchmark execution scope is no longer authorized.",
    );
  const { data: run, error } = await admin
    .from("agent_runs")
    .select("id, session_id, agent_job_id, attempt_count")
    .eq("id", sourceRunId)
    .eq("workspace_id", workspaceId)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (error || !run)
    throw new BenchmarkReplayUnavailable("The source benchmark attempt is unavailable.");
  return {
    admin,
    factoryId,
    run,
    access: {
      workspace: { id: workspaceId },
      listSourceAccess: (sourceIds) =>
        admin
          .rpc("benchmark_list_factory_context_source_access", {
            ...authority,
            p_source_ids: sourceIds,
          })
          .abortSignal(signal),
    },
  };
}

async function requireSourceAvailability(scope: Scope) {
  const preview = await loadBenchmarkSource(scope);
  if (preview.eligibility.status === "ineligible")
    throw new BenchmarkReplayUnavailable(preview.eligibility.reasons.join(" "));
}

function compareAttempt(snapshot: Snapshot, attempt: Tables<"session_attempt_manifests">) {
  return (
    attempt.repository_id === snapshot.repository_id &&
    attempt.input_sha === snapshot.input_sha &&
    attempt.input_ref === snapshot.input_ref &&
    attempt.checkout_sha === snapshot.checkout_sha &&
    attempt.source_checkpoint_run_id === snapshot.source_checkpoint_run_id &&
    attempt.retry_source_run_id === snapshot.retry_source_run_id &&
    attempt.definition_revision_id === snapshot.definition_revision_id &&
    attempt.definition_digest === snapshot.definition_digest &&
    attempt.prompt_sha256 === snapshot.rendered_prompt_sha256 &&
    attempt.renderer_version === snapshot.renderer_version
  );
}

async function readRetryBundle(scope: Scope, snapshot: Snapshot, signal: AbortSignal) {
  if (!snapshot.retry_source_run_id) {
    if (snapshot.checkout_sha !== snapshot.input_sha || snapshot.retry_bundle_sha256 !== null) {
      throw new BenchmarkReplayUnavailable(
        "The benchmark's starting checkout receipt is inconsistent.",
      );
    }
    return null;
  }
  const workspaceId = scope.access.workspace.id;
  const [binding, bundle] = await Promise.all([
    scope.admin
      .from("session_retry_checkpoint_jobs")
      .select("source_run_id")
      .eq("workspace_id", workspaceId)
      .eq("job_id", snapshot.source_job_id)
      .eq("source_run_id", snapshot.retry_source_run_id)
      .abortSignal(signal)
      .maybeSingle(),
    scope.admin
      .from("session_retry_checkpoints")
      .select("checkpoint_path, bundle_sha256")
      .eq("workspace_id", workspaceId)
      .eq("source_run_id", snapshot.retry_source_run_id)
      .eq("input_sha", snapshot.input_sha)
      .eq("head_sha", snapshot.checkout_sha)
      .abortSignal(signal)
      .maybeSingle(),
  ]);
  if (
    binding.error ||
    bundle.error ||
    !binding.data ||
    !bundle.data ||
    bundle.data.bundle_sha256 !== snapshot.retry_bundle_sha256
  ) {
    throw new BenchmarkReplayUnavailable(
      "The original retry bundle receipt is unavailable or changed.",
    );
  }
  const object = await scope.admin.storage
    .from(SOURCE_CHECKPOINT_BUCKET)
    .download(bundle.data.checkpoint_path, {}, { signal });
  if (object.error || !object.data || object.data.size > MAX_SOURCE_CHECKPOINT_BYTES)
    throw new BenchmarkReplayUnavailable("The original retry bundle is unavailable.");
  const bytes = Buffer.from(await object.data.arrayBuffer());
  if (replaySha256(bytes) !== snapshot.retry_bundle_sha256)
    throw new BenchmarkReplayUnavailable("The original retry bundle failed its digest check.");
  return bytes;
}

function qualifyReplay(
  snapshot: Snapshot,
  runtime: ReplayRuntime,
  candidate: ReplayCandidate | undefined,
) {
  const limits: ReplayLimit[] = [
    "rendered_prompt_bytes_unavailable",
    "model_version_unverified",
    "runtime_version_unrecorded",
  ];
  if (snapshot.renderer_version !== STAGE_PROMPT_RENDERER_VERSION)
    limits.push("renderer_version_changed");
  const candidateChanges: (keyof ReplayCandidate)[] = [];
  if (candidate?.harness !== undefined && candidate.harness !== runtime.harness)
    candidateChanges.push("harness");
  if (candidate?.model !== undefined && candidate.model !== runtime.model)
    candidateChanges.push("model");
  if (
    candidate?.definitionDigest !== undefined &&
    candidate.definitionDigest !== snapshot.definition_digest
  )
    candidateChanges.push("definitionDigest");
  if (candidateChanges.length) limits.push("candidate_inputs_changed");
  return { limits, candidateChanges };
}

export async function resolveBenchmarkReplay(input: BenchmarkReplayInput) {
  const { factoryId, taskRevisionId, signal } = input;
  const candidate = input.candidate && replayCandidateSchema.parse(input.candidate);
  const workspaceId =
    "principal" in input ? input.principal.workspaceId : input.access.workspace.id;
  const client = "principal" in input ? input.principal.admin : input.access.supabase;
  signal.throwIfAborted();
  const task = await client
    .from("factory_benchmark_task_revisions")
    .select(
      "task_id, replay_eligibility, factory_benchmark_tasks!inner(source_run_id,source_session_id)",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", taskRevisionId)
    .abortSignal(signal)
    .maybeSingle();
  if (task.error || !task.data || task.data.replay_eligibility !== "eligible")
    throw new BenchmarkReplayUnavailable(
      "The selected benchmark task revision is unavailable or ineligible.",
    );
  const { source_run_id: sourceRunId, source_session_id: sessionId } =
    task.data.factory_benchmark_tasks;
  const authorize = () =>
    "principal" in input
      ? authorizeWorkerReplay(input.principal, factoryId, sourceRunId, taskRevisionId, signal)
      : authorizeReplay(input.access, factoryId, sourceRunId, taskRevisionId);
  const scope = await authorize();
  if (scope.run.session_id !== sessionId)
    throw new BenchmarkReplayUnavailable("The benchmark source session changed.");

  const receipt = await scope.admin
    .from("factory_benchmark_task_inputs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("task_id", task.data.task_id)
    .eq("source_run_id", sourceRunId)
    .eq("source_session_id", sessionId)
    .abortSignal(signal)
    .maybeSingle();
  const snapshot = snapshotSchema.safeParse(receipt.data);
  if (
    receipt.error ||
    !snapshot.success ||
    snapshot.data.source_job_id !== scope.run.agent_job_id ||
    snapshot.data.source_attempt_count !== scope.run.attempt_count
  ) {
    throw new BenchmarkReplayUnavailable("The exact source attempt receipt is unavailable.");
  }
  const pinned = snapshot.data;

  const [attempt, admission, context, definition, repository] = await Promise.all([
    scope.admin
      .from("session_attempt_manifests")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("session_id", sessionId)
      .eq("run_id", sourceRunId)
      .eq("job_id", pinned.source_job_id)
      .eq("attempt_count", pinned.source_attempt_count)
      .abortSignal(signal)
      .maybeSingle(),
    scope.admin
      .from("session_factory_admission_inputs")
      .select(
        "original_title, original_prompt_md, prompt_sha256, definition_revision_id, definition_digest, github_repository_id, execution_grant_id, execution_grant_version",
      )
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("session_id", sessionId)
      .abortSignal(signal)
      .maybeSingle(),
    scope.admin
      .from("session_run_context_manifests")
      .select("manifest_sha256, origin_run_id, canonical:manifest::text")
      .eq("workspace_id", workspaceId)
      .eq("session_id", sessionId)
      .eq("run_id", sourceRunId)
      .eq("job_id", pinned.source_job_id)
      .eq("attempt_count", pinned.source_attempt_count)
      .abortSignal(signal)
      .maybeSingle(),
    scope.admin
      .from("factory_definition_revisions")
      .select("definition_json, canonical_digest")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("id", pinned.definition_revision_id)
      .abortSignal(signal)
      .maybeSingle(),
    readConnectedRepository(scope, pinned.repository_id),
  ]);
  const { data: observed } = attempt;
  if (attempt.error || !observed || !compareAttempt(pinned, observed))
    throw new BenchmarkReplayUnavailable(
      "The recorded attempt does not match the benchmark receipt.",
    );
  if (!repository || repository.repositoryFullName !== observed.repository_full_name)
    throw new BenchmarkReplayUnavailable(
      "Current access to the recorded starting repository is unavailable.",
    );
  const original = admission.data;
  const originalPrompt = original?.original_prompt_md;
  if (
    admission.error ||
    !original ||
    typeof originalPrompt !== "string" ||
    original.definition_revision_id !== pinned.definition_revision_id ||
    original.definition_digest !== pinned.definition_digest ||
    original.prompt_sha256 !== pinned.original_prompt_sha256 ||
    replaySha256(originalPrompt) !== pinned.original_prompt_sha256
  )
    throw new BenchmarkReplayUnavailable("The original task prompt is unavailable or changed.");
  const contextJson = context.data?.canonical;
  if (
    context.error ||
    typeof contextJson !== "string" ||
    context.data?.origin_run_id !== pinned.context_origin_run_id ||
    context.data?.manifest_sha256 !== pinned.context_manifest_sha256 ||
    replaySha256(contextJson) !== pinned.context_manifest_sha256
  )
    throw new BenchmarkReplayUnavailable(
      "The recorded context manifest is unavailable or changed.",
    );
  const manifest = runContextManifestSchema.safeParse(JSON.parse(contextJson));
  if (!manifest.success)
    throw new BenchmarkReplayUnavailable("The recorded context manifest format is unsupported.");
  const definitionJson = definition.data?.definition_json;
  const compiled =
    typeof definitionJson === "string"
      ? readVerifiedFactoryDefinition(definitionJson, pinned.definition_digest)
      : null;
  if (
    definition.error ||
    typeof definitionJson !== "string" ||
    !compiled ||
    definition.data?.canonical_digest !== pinned.definition_digest ||
    original.github_repository_id !== pinned.repository_id ||
    !factoryWritableRepositoryIds(compiled).includes(pinned.repository_id) ||
    compiled.skillIds.length !== observed.definition_skill_ids.length ||
    compiled.skillIds.some((id, index) => id !== observed.definition_skill_ids[index]) ||
    !compiled.implementationAgent
  )
    throw new BenchmarkReplayUnavailable(
      "The original factory definition or its skill identities changed.",
    );
  const worker = runtimeSchema.safeParse(observed.worker_runtime);
  if (!worker.success)
    throw new BenchmarkReplayUnavailable("The original worker runtime is unsupported.");

  await requireSourceAvailability(scope);
  const grant = { id: original.execution_grant_id, version: original.execution_grant_version };
  const [required, dependencies, skills, agentPrompt, retryBytes] = await Promise.all([
    readRequiredRunInputs(
      {
        admin: scope.admin,
        workspaceId,
        sessionId,
        stageId: observed.stage_id,
        recordedAt: observed.created_at,
      },
      manifest.data.required,
      { title: original.original_title, prompt: originalPrompt },
      (reference) =>
        verifyBenchmarkRepositoryInput(
          scope,
          { grantId: grant.id, grantVersion: grant.version },
          reference,
        ),
    ),
    readReplayContext(scope, manifest.data, grant),
    loadFactorySkillBundle(scope.admin, {
      workspaceId,
      factoryId,
      skillRevisionIds: compiled.skillIds,
      signal,
    }),
    loadRunAgentPrompt(scope.admin, {
      workspaceId,
      factoryId,
      sessionId,
      runId: sourceRunId,
      expected: compiled.implementationAgent,
    }),
    readRetryBundle(scope, pinned, signal),
  ]);
  if (required.reasons.length) throw new BenchmarkReplayUnavailable(required.reasons.join(" "));
  const readRepositories = new Map(
    required.repositories.map(({ repositoryId, commitSha }) => [repositoryId, commitSha]),
  );
  const expectedRepositories = compiled.readContextRepositoryIds ?? [];
  if (
    readRepositories.size !== required.repositories.length ||
    readRepositories.size !== expectedRepositories.length ||
    expectedRepositories.some((repositoryId) => !readRepositories.has(repositoryId))
  ) {
    throw new BenchmarkReplayUnavailable(
      "The recorded repository context list does not match the pinned definition.",
    );
  }
  const runtime: ReplayRuntime = {
    harness: observed.model_provider,
    model: observed.model_name,
    worker: worker.data,
    sandboxProvider: observed.sandbox_provider,
    sandboxConnectionRevision: observed.sandbox_connection_revision,
    stageId: observed.stage_id,
    runType: observed.run_type,
    agentEffort: observed.agent_effort,
    maxTurns: observed.max_turns,
  };
  const plan: ReplayPlan = {
    identity: {
      taskRevisionId,
      sourceRunId,
      sourceSessionId: sessionId,
      sourceJobId: pinned.source_job_id,
      sourceAttemptCount: pinned.source_attempt_count,
      repositoryId: pinned.repository_id,
      definitionRevisionId: pinned.definition_revision_id,
      inputSha: pinned.input_sha,
      inputRef: pinned.input_ref,
      checkoutSha: pinned.checkout_sha,
      retryBundleSha256: pinned.retry_bundle_sha256,
      definitionDigest: pinned.definition_digest,
      contextManifestSha256: pinned.context_manifest_sha256,
      originalPromptSha256: pinned.original_prompt_sha256,
      renderedPromptSha256: pinned.rendered_prompt_sha256,
      rendererVersion: pinned.renderer_version,
    },
    runtime,
    readRepositories,
    retryBytes,
    text: {
      originalPrompt,
      definitionJson,
      contextManifestJson: contextJson,
      required: required.text,
      ...dependencies,
      skills: skills.map(({ value }, index) => ({
        revisionId: compiled.skillIds[index],
        body: value,
      })),
      agentPrompt: { revisionId: agentPrompt.promptRevisionId, body: agentPrompt.promptMd },
    },
    ...qualifyReplay(pinned, runtime, candidate),
  };
  signal.throwIfAborted();
  return {
    plan,
    repository,
    baseBranch: observed.base_branch,
    async recheckAccess() {
      signal.throwIfAborted();
      const currentScope = await authorize();
      const currentRepository = await readConnectedRepository(currentScope, pinned.repository_id);
      if (
        !currentRepository ||
        currentRepository.repositoryId !== repository.repositoryId ||
        currentRepository.repositoryFullName !== repository.repositoryFullName ||
        currentRepository.recordedInstallationId !== repository.recordedInstallationId ||
        currentRepository.installationId !== repository.installationId
      ) {
        throw new BenchmarkReplayUnavailable(
          "Current access to the recorded starting repository is unavailable.",
        );
      }
      await requireSourceAvailability(currentScope);
      await readReplayContext(currentScope, manifest.data, grant);
      signal.throwIfAborted();
    },
  };
}
