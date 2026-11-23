import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { loadPinnedFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import { publishSessionCheckpoint } from "@/lib/pipeline/checkpoint-publication";
import {
  ExecutionBudgetExhaustedError,
  loadSessionExecutionBudget,
} from "@/lib/pipeline/execution-budget";
import {
  deferSessionJobForGitContinuityRelease,
  isGitContinuityReleasePause,
} from "@/lib/pipeline/git-continuity-release";
import { captureCommittedSourceCheckpoint } from "@/lib/pipeline/source-checkpoint";
import { prepareSourceDelivery } from "@/lib/pipeline/source-delivery";
import { WorkerAttemptDeadlineError } from "@/lib/pipeline/worker-attempt-deadline";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import type {
  BrowserScreenshotRuntime,
  BrowserVideoRuntime,
} from "@/lib/validation-evidence/browser-contract";
import { recordBrowserVerification } from "@/lib/validation-evidence/browser-service";
import {
  captureValidationEvidence,
  readValidationIdentity,
} from "@/lib/validation-evidence/capture";
import { validationPlanSchema } from "@/lib/validation-evidence/contracts";
import { pinValidationPlan, validationPlanPath } from "@/lib/validation-evidence/plan";
import { evaluateExactRunValidationEvidence } from "@/lib/validation-evidence/read-run-evidence";
import { persistValidationEvidence } from "@/lib/validation-evidence/service";
import { loadPinnedSessionJobGitInput } from "@/lib/wallie/service";
import { retainJoinConflict, type PrivateConflictObjects } from "./join-conflict";
import {
  integrateJoin,
  runBoundedJoinMerge,
  type IntegrationOutcome,
  type JoinPlan,
} from "./join-git";
import { startFactoryWorkflowJoinClaim } from "./join-worker-claim";
import { selectJoinValidationPlan } from "./join-validation-plan";
import { prepareJoinValidationDependencies } from "./join-validation-dependencies";
import { exportValidationSource, materializeValidationSource } from "./join-validation-source";

type AdminClient = SupabaseClient<Database>;
type Started = Extract<
  Awaited<ReturnType<typeof startFactoryWorkflowJoinClaim>>,
  { kind: "started" }
>;
type Candidate = Extract<IntegrationOutcome, { kind: "candidate" }>;
type Job = Pick<Tables<"agent_jobs">, "id" | "workspace_id" | "session_id" | "attempt_count">;

export type Context = {
  admin: AdminClient;
  claim: Started;
  deadlineAt: string;
  signal: AbortSignal;
};
export type ManagedResources = {
  // Provisioning, deadline propagation, and positive remote cleanup belong here.
  integrate<T>(context: Context, work: (sandbox: SandboxHandle) => Promise<T>): Promise<T>;
  validate<T>(context: Context, work: (sandbox: SandboxHandle) => Promise<T>): Promise<T>;
  conflicts(context: Context): PrivateConflictObjects;
};

const uuid = z.string().uuid();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const branchEdge = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const scope = { root_session_id: uuid, join_id: uuid };

const sealedJoin = z.object({
  manifest: z.object({
    ...scope,
    workspace_id: uuid,
    factory_id: uuid,
    parent_session_id: uuid,
    expected_head_run_id: uuid,
    expected_generation: z.number().int().positive().safe(),
    repository_id: uuid,
    base_sha: sha,
    required_evidence: z.array(z.string().min(1).max(200)).min(1).max(100),
    admitted_at: z.string().datetime({ offset: true }),
  }),
  attempt: z.object({
    ...scope,
    run_id: uuid,
    job_id: uuid,
    attempt_count: z.number().int().positive(),
  }),
  candidate: z.null(),
  outcome: z.null(),
  inputs: z
    .array(
      z.discriminatedUnion("selected", [
        z.object({
          ...scope,
          selected: z.literal(true),
          branch_edge_id: branchEdge,
          outcome_id: uuid,
          branchOutput: z.object({
            root_session_id: uuid,
            outcome_id: uuid,
            outcome: z.literal("succeeded"),
            checkpoint_run_id: uuid,
            child_session_id: uuid,
            job_id: uuid,
            attempt_count: z.number().int().positive(),
            run_id: uuid,
            attempt_input_sha: sha,
            output_sha: sha,
            retained_ref: z.string().nullable(),
          }),
        }),
        z.object({ ...scope, selected: z.literal(false) }),
      ]),
    )
    .min(1)
    .max(128),
});

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
function joinRpcScope(claim: Started) {
  return {
    p_root_session_id: claim.rootSessionId,
    p_workspace_id: claim.workspaceId,
    p_factory_id: claim.factoryId,
    p_join_id: claim.joinId,
  };
}

async function loadJoinInput({ admin, claim, signal }: Context) {
  const [snapshot, input, session] = await Promise.all([
    admin.rpc("read_factory_workflow_join", joinRpcScope(claim)).abortSignal(signal),
    loadPinnedSessionJobGitInput({
      admin,
      jobId: claim.jobId,
      sessionId: claim.parentSessionId,
      workspaceId: claim.workspaceId,
    }),
    admin
      .from("sessions")
      .select(
        "workspace_id,factory_definition_revision_id,execute_pinned_definition,current_stage_id,specification_stage_id",
      )
      .eq("id", claim.parentSessionId)
      .eq("workspace_id", claim.workspaceId)
      .eq("factory_id", claim.factoryId)
      .abortSignal(signal)
      .single(),
  ]);
  signal.throwIfAborted();
  const parsed = sealedJoin.safeParse(snapshot.data);
  if (snapshot.error || !parsed.success || !input || session.error)
    throw new Error("The sealed join inputs are unavailable.");
  const { manifest, attempt, inputs } = parsed.data;
  if (
    manifest.workspace_id !== claim.workspaceId ||
    manifest.factory_id !== claim.factoryId ||
    manifest.parent_session_id !== claim.parentSessionId ||
    manifest.expected_generation !== claim.generation ||
    manifest.base_sha !== claim.baseSha ||
    input.input_sha !== claim.baseSha ||
    input.input_ref !== claim.baseRef ||
    input.repository_id !== manifest.repository_id ||
    input.source_checkpoint_run_id !== manifest.expected_head_run_id ||
    input.pinned_run_id !== claim.runId ||
    input.pinned_attempt_count !== claim.attemptCount ||
    attempt.job_id !== claim.jobId ||
    attempt.run_id !== claim.runId ||
    attempt.attempt_count !== claim.attemptCount ||
    [manifest, attempt, ...inputs].some(
      (row) => row.root_session_id !== claim.rootSessionId || row.join_id !== claim.joinId,
    )
  )
    throw new Error("The sealed join inputs diverged from the exact typed claim.");

  const branches: JoinPlan["branches"] = [];
  const selected = inputs.filter((input) => input.selected);
  for (const branch of selected) {
    const receipt = branch.branchOutput;
    if (
      receipt.root_session_id !== claim.rootSessionId ||
      receipt.outcome_id !== branch.outcome_id ||
      receipt.checkpoint_run_id !== receipt.run_id
    )
      throw new Error("A selected branch receipt has another source.");
    branches.push({
      edgeId: branch.branch_edge_id,
      checkpointRunId: receipt.checkpoint_run_id,
      inputSha: receipt.attempt_input_sha,
      outputSha: receipt.output_sha,
      retainedRef: receipt.retained_ref,
    });
  }

  const [prior, priorPlan, definition] = await Promise.all([
    admin
      .from("session_git_checkpoints")
      .select("job_id,attempt_count,input_sha,output_ref,output_kind")
      .eq("workspace_id", claim.workspaceId)
      .eq("session_id", claim.parentSessionId)
      .eq("repository_id", manifest.repository_id)
      .eq("output_sha", claim.baseSha)
      .eq("run_id", manifest.expected_head_run_id)
      .abortSignal(signal)
      .single(),
    admin
      .from("session_validation_plans")
      .select("job_id,attempt_count,plan")
      .eq("workspace_id", claim.workspaceId)
      .eq("session_id", claim.parentSessionId)
      .eq("repository_id", manifest.repository_id)
      .eq("commit_sha", claim.baseSha)
      .eq("run_id", manifest.expected_head_run_id)
      .abortSignal(signal)
      .maybeSingle(),
    loadPinnedFactoryExecution(admin, session.data, signal),
  ]);
  signal.throwIfAborted();
  if (
    prior.error ||
    priorPlan.error ||
    !definition ||
    (prior.data.output_kind === "code" && prior.data.output_ref !== claim.baseRef) ||
    (priorPlan.data &&
      (prior.data.job_id !== priorPlan.data.job_id ||
        prior.data.attempt_count !== priorPlan.data.attempt_count))
  ) {
    throw new Error("The exact parent checkpoint's frozen validation plan is unavailable.");
  }

  const specificationParent = session.data.specification_stage_id === session.data.current_stage_id;
  async function loadValidation() {
    if (priorPlan.data) {
      return selectJoinValidationPlan(
        [validationPlanSchema.parse(priorPlan.data.plan)],
        manifest.required_evidence,
      );
    } else if (specificationParent) {
      // The specification run intentionally has no runnable plan. Its selected,
      // immutable branch receipts pin the only admissible fallback plan sources.
      const sources = await admin
        .from("session_validation_plans")
        .select("run_id,session_id,job_id,attempt_count,commit_sha,plan")
        .eq("workspace_id", claim.workspaceId)
        .eq("repository_id", manifest.repository_id)
        .in(
          "run_id",
          selected.map(({ branchOutput }) => branchOutput.run_id),
        )
        .abortSignal(signal);
      if (sources.error) throw new Error("The frozen branch validation plans are unavailable.");
      signal.throwIfAborted();
      const plans = selected.flatMap(({ branchOutput: receipt }) => {
        const source = sources.data.find((row) => row.run_id === receipt.run_id);
        if (!source) return [];
        if (
          source.session_id !== receipt.child_session_id ||
          source.job_id !== receipt.job_id ||
          source.attempt_count !== receipt.attempt_count ||
          source.commit_sha !== receipt.output_sha
        )
          throw new Error("A branch validation plan belongs to another checkpoint.");
        return [validationPlanSchema.parse(source.plan)];
      });
      return selectJoinValidationPlan(plans, manifest.required_evidence);
    } else {
      throw new Error("The exact parent checkpoint has no frozen validation plan.");
    }
  }
  const plan: JoinPlan = {
    joinId: claim.joinId,
    admittedAt: manifest.admitted_at,
    parent: {
      checkpointRunId: manifest.expected_head_run_id,
      inputSha: prior.data.input_sha,
      outputSha: claim.baseSha,
      retainedRef: claim.baseRef,
    },
    branches,
  };
  return {
    plan,
    loadValidation,
    requiredKeys: manifest.required_evidence,
    repositoryId: manifest.repository_id,
    repositoryName: repoName.parse(input.repository_full_name),
    baseBranch: input.base_branch,
    approvedToolIds: definition.toolIds,
  };
}

async function resolveCheckout(
  { admin, claim, signal }: Context,
  input: Awaited<ReturnType<typeof loadJoinInput>>,
) {
  const repository = await admin
    .from("github_repositories")
    .select("full_name,repo_id,github_installation_id,is_archived")
    .eq("workspace_id", claim.workspaceId)
    .eq("id", input.repositoryId)
    .abortSignal(signal)
    .single();
  if (
    repository.error ||
    repository.data.is_archived ||
    repository.data.full_name.toLowerCase() !== input.repositoryName.toLowerCase() ||
    !Number.isSafeInteger(repository.data.repo_id) ||
    repository.data.repo_id <= 0
  )
    throw new Error("The pinned join repository is unavailable.");
  const installation = await admin
    .from("github_installations")
    .select("installation_id")
    .eq("id", repository.data.github_installation_id)
    .eq("workspace_id", claim.workspaceId)
    .eq("suspended", false)
    .abortSignal(signal)
    .single();
  if (installation.error) throw new Error("The pinned join installation is unavailable.");
  signal.throwIfAborted();
  const token = await mintSandboxRepositoryToken({
    installationId: installation.data.installation_id,
    repositoryId: repository.data.repo_id,
    repositoryFullName: input.repositoryName,
    purpose: "checkout",
    signal,
  });
  signal.throwIfAborted();
  // Read-only checkout credentials carry the numeric ID. Verify the current
  // route too, since the same name can be reused and a public clone can succeed.
  const response = await fetch(`https://api.github.com/repos/${input.repositoryName}`, {
    signal,
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Wallie",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error("The pinned join repository identity is unavailable.");
  const identity = z
    .object({ id: z.number().int().positive().safe(), full_name: repoName })
    .safeParse(await response.json());
  signal.throwIfAborted();
  if (
    !identity.success ||
    identity.data.id !== repository.data.repo_id ||
    identity.data.full_name.toLowerCase() !== input.repositoryName.toLowerCase()
  ) {
    throw new Error("The pinned join repository identity changed.");
  }
  return { url: `https://github.com/${input.repositoryName}.git`, token };
}

const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TEMPLATE_DIR: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "0",
};

async function isolatedGit(
  sandbox: SandboxHandle,
  args: string[],
  options: { signal: AbortSignal; env?: Record<string, string> },
) {
  let output: { stdout: string; stderr: string };
  let code: number;
  try {
    const proc = await sandbox.exec("git", args, {
      signal: options.signal,
      env: { ...gitEnvironment, ...options.env },
    });
    [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  } catch {
    options.signal.throwIfAborted();
    // Provider failures can echo command options. The fetch options carry a token.
    throw new Error("The join Git command failed.");
  }
  if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 1024 * 1024)
    throw new Error("The join Git command exceeded its output limit.");
  options.signal.throwIfAborted();
  return { stdout: output.stdout, code };
}

function matchesCandidate(
  found: Awaited<ReturnType<typeof readValidationIdentity>>,
  candidate: Candidate,
) {
  return (
    found.clean && found.commitSha === candidate.commitSha && found.treeSha === candidate.treeSha
  );
}

async function saveBlocker(
  { admin, claim, signal }: Context,
  blocker:
    | { outcome: "validation_failed"; detail: Record<string, never> }
    | {
        outcome: "conflict";
        detail: Awaited<ReturnType<typeof retainJoinConflict>>;
      },
) {
  const { data, error } = await admin
    .rpc("settle_factory_workflow_join_blocker", {
      ...joinRpcScope(claim),
      p_expected_generation: claim.generation,
      p_ownership_token: claim.ownershipToken,
      p_job_id: claim.jobId,
      p_run_id: claim.runId,
      p_attempt_count: claim.attemptCount,
      p_outcome: blocker.outcome,
      p_detail: blocker.detail,
    })
    .abortSignal(signal);
  if (error || (data !== "blocked" && data !== "stale"))
    throw new Error("The exact join blocker could not be settled.");
}

export async function processFactoryWorkflowJoinJob(input: {
  admin: AdminClient;
  job: Job;
  signal: AbortSignal;
  deadlineAt: string;
  resources: ManagedResources;
  browserRuntime?: BrowserScreenshotRuntime;
  browserVideoRuntime?: BrowserVideoRuntime;
}): Promise<"ordinary" | "handled"> {
  let claim: Awaited<ReturnType<typeof startFactoryWorkflowJoinClaim>>;
  try {
    claim = await startFactoryWorkflowJoinClaim(input);
  } catch (error) {
    if (!isGitContinuityReleasePause(error)) throw new Error("Workflow join dispatch failed.");
    if (
      !(await deferSessionJobForGitContinuityRelease({
        admin: input.admin,
        jobId: input.job.id,
        attemptCount: input.job.attempt_count,
      }))
    )
      throw new Error("Workflow join release deferral could not be verified.");
    return "handled";
  }
  if (claim.kind === "ordinary") return "ordinary";
  if (claim.kind === "started_elsewhere") return "handled";
  if (claim.kind === "retired")
    throw new Error("This workflow join claim no longer owns an attempt.");
  const deadlineMs = Math.min(Date.parse(input.deadlineAt), Date.parse(claim.deadlineAt));
  const deadlineAt = new Date(deadlineMs).toISOString();
  const reason =
    claim.deadlineReason === "elapsed_execution"
      ? new ExecutionBudgetExhaustedError("elapsed_execution")
      : new WorkerAttemptDeadlineError("The workflow join attempt exceeded its deadline.");
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw reason;

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(reason), remainingMs);
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const context = { admin: input.admin, claim, deadlineAt, signal };
  try {
    return await observeUntilAbort(signal, async () => {
      const budget = await loadSessionExecutionBudget(context.admin, context.claim.parentSessionId);
      signal.throwIfAborted();
      if (budget?.exhaustionCode) throw new ExecutionBudgetExhaustedError(budget.exhaustionCode);
      await runStartedJoin(context, input);
      return "handled" as const;
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runStartedJoin(
  context: Context,
  input: {
    resources: ManagedResources;
    browserRuntime?: BrowserScreenshotRuntime;
    browserVideoRuntime?: BrowserVideoRuntime;
  },
) {
  const { admin, claim, deadlineAt, signal } = context;
  const { resources } = input;
  const frozen = await loadJoinInput(context);
  const integration = await resources.integrate(context, async (sandbox) => {
    const repository = await resolveCheckout(context, frozen);
    const result = await integrateJoin(
      frozen.plan,
      {
        git: (args, options) => isolatedGit(sandbox, args, options),
        merge: (args, { signal }) =>
          runBoundedJoinMerge(sandbox, args, { signal, env: gitEnvironment }),
        fetch: async (selector, fetchSignal) => {
          const encoded = Buffer.from("x-access-token:" + repository.token).toString("base64");
          const result = await isolatedGit(
            sandbox,
            [
              "-c",
              "credential.helper=",
              "-c",
              "http.followRedirects=false",
              "fetch",
              "--no-tags",
              "--no-write-commit-graph",
              "--no-auto-maintenance",
              repository.url,
              selector,
            ],
            {
              signal: fetchSignal,
              env: {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0: "Authorization: Basic " + encoded,
              },
            },
          );
          if (result.code !== 0) throw new Error("The exact join input could not be fetched.");
        },
      },
      signal,
    );
    if (result.kind === "conflict") return result;
    // The full-history incremental bundle and the detached validation transfer
    // serve different purposes. Only the incremental bundle can be published.
    const checkpoint = await captureCommittedSourceCheckpoint({
      sandbox,
      baseSha: claim.baseSha,
      headSha: result.commitSha,
      sensitiveValues: [repository.token],
      scopedCredential: true,
      signal,
    });
    const source = await exportValidationSource(sandbox, result, signal);
    return { ...result, checkpoint, source };
  });

  if (integration.kind === "conflict") {
    const detail = await retainJoinConflict(
      resources.conflicts(context),
      {
        workspaceId: claim.workspaceId,
        rootSessionId: claim.rootSessionId,
        joinId: claim.joinId,
        runId: claim.runId,
      },
      integration,
      signal,
    );
    await saveBlocker(context, { outcome: "conflict", detail });
    return;
  }
  const validation = await frozen.loadValidation();
  const recorded = await admin
    .rpc("record_active_factory_workflow_join_candidate", {
      ...joinRpcScope(claim),
      p_expected_generation: claim.generation,
      p_ownership_token: claim.ownershipToken,
      p_run_id: claim.runId,
      p_job_id: claim.jobId,
      p_attempt_count: claim.attemptCount,
      p_commit_sha: integration.commitSha,
      p_tree_sha: integration.treeSha,
      ...(integration.checkpoint.kind === "bundle"
        ? {
            p_bundle_sha256: integration.checkpoint.sha256,
          }
        : {}),
    })
    .abortSignal(signal);
  if (recorded.error || recorded.data !== true)
    throw new Error("The exact join candidate was not recorded.");
  const unchanged = await resources.validate(context, async (sandbox) => {
    await materializeValidationSource(sandbox, integration, integration.source, signal);
    if (!matchesCandidate(await readValidationIdentity(sandbox, signal), integration))
      throw new Error("The validation workspace does not contain the joined commit and tree.");
    await sandbox.writeFile(validationPlanPath(claim.runId), JSON.stringify(validation), {
      mode: 0o600,
    });
    const pinned = await pinValidationPlan({
      admin,
      sandbox,
      runId: claim.runId,
      commitSha: integration.commitSha,
      secrets: [],
      signal,
    });
    const preparedSandbox = await prepareJoinValidationDependencies(sandbox, signal);
    const evidence = await captureValidationEvidence({
      sandbox: preparedSandbox,
      commitSha: integration.commitSha,
      plan: pinned.plan,
      signal,
    });
    await persistValidationEvidence({
      admin,
      workspaceId: claim.workspaceId,
      runId: claim.runId,
      evidence,
      signal,
    });
    if ("browserIdentity" in pinned) {
      await recordBrowserVerification({
        admin,
        workspaceId: claim.workspaceId,
        plan: pinned.plan.browser,
        identity: pinned.browserIdentity,
        sourceMatches: matchesCandidate(await readValidationIdentity(sandbox, signal), integration),
        runtime: input.browserRuntime,
        videoRuntime: input.browserVideoRuntime,
        approvedToolIds: frozen.approvedToolIds,
        signal,
      });
    }
    return matchesCandidate(await readValidationIdentity(sandbox, signal), integration);
  });

  const requirements = await evaluateExactRunValidationEvidence({
    admin,
    requiredKeys: frozen.requiredKeys,
    source: {
      workspace_id: claim.workspaceId,
      session_id: claim.parentSessionId,
      job_id: claim.jobId,
      run_id: claim.runId,
      attempt_count: claim.attemptCount,
      repository_id: frozen.repositoryId,
      output_sha: integration.commitSha,
      validation_tree_sha: integration.treeSha,
    },
  });
  signal.throwIfAborted();
  if (requirements.some(({ status }) => status === "failed" || status === "stale")) {
    await saveBlocker(context, { outcome: "validation_failed", detail: {} });
    return;
  }
  if (!unchanged) throw new Error("Validation changed the joined source.");
  if (requirements.some(({ status }) => status !== "passed"))
    throw new Error("Required joined validation evidence is unavailable.");

  const artifact = [
    "# Workflow join",
    "",
    `Integrated ${frozen.plan.branches.length} retained branch checkpoints.`,
    "",
    `Integrated commit: \`${integration.commitSha}\``,
    `Validated tree: \`${integration.treeSha}\``,
  ].join("\n");
  const prepared = await prepareSourceDelivery({
    admin,
    baseBranch: frozen.baseBranch,
    checkpoint: integration.checkpoint,
    title: "Workflow join",
    body: artifact,
    workspaceId: claim.workspaceId,
    runId: claim.runId,
    repositoryId: frozen.repositoryId,
    signal,
    onDurable: () => undefined,
    publication: {
      expectedArtifactVersion: claim.artifactVersion,
      artifactMarkdown: artifact,
      deadlineAt,
    },
  });
  if (!prepared) throw new Error("The joined publication lost its exact attempt.");
  await publishSessionCheckpoint({
    admin,
    workspaceId: claim.workspaceId,
    runId: claim.runId,
    jobId: claim.jobId,
    attemptCount: claim.attemptCount,
    expectedArtifactVersion: claim.artifactVersion,
    artifactMarkdown: artifact,
    deadlineAt,
    signal,
  });
}
