import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Enums, Tables, TablesInsert } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";
import {
  buildWallieBlockingReasons,
  inferWallieRunMode,
  parseWallieRunMode,
} from "@/features/wallie/utils";
import type {
  WallieActionErrorCode,
  WallieBlockingReason,
  WallieIssueRepository,
  WallieRunMode,
} from "@/features/wallie/types";
import { loadWorkspaceAgentConfig } from "@/lib/agent-runner";
import { buildWallieJobDedupeKey, WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type WorkspaceAccessWorkspace = Pick<Tables<"workspaces">, "id" | "name" | "slug">;
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type SessionForRun = Pick<
  Tables<"sessions">,
  "created_at" | "id" | "number" | "prompt_md" | "title" | "workspace_id"
> & { github_repository_id: string | null };
type RepositoryForRun = Pick<
  Tables<"github_repositories">,
  | "default_branch"
  | "default_programming_language"
  | "full_name"
  | "html_url"
  | "id"
  | "is_archived"
  | "private"
  | "workspace_id"
>;
type AgentJobRow = Tables<"agent_jobs">;
type AgentRunRow = Tables<"agent_runs">;

const sessionSelect = "id, workspace_id, number, title, prompt_md, created_at";
const repositorySelect =
  "id, workspace_id, full_name, html_url, private, default_programming_language, default_branch, is_archived";
const jobSelect =
  "id, workspace_id, session_id, requested_by_member_id, trigger_type, status, attempt_count, last_error, dedupe_key, job_type, scheduled_at, started_at, finished_at, created_at, updated_at";
const runSelect =
  "id, workspace_id, session_id, agent_job_id, triggered_by_member_id, run_type, model_provider, model_name, status, started_at, finished_at, last_activity_at, input_tokens, output_tokens, total_cost_usd, sandbox_id, created_at, updated_at";

export class WallieActionError extends Error {
  readonly code: WallieActionErrorCode;
  readonly missingSecretKeys?: string[];
  readonly statusCode: number;

  constructor(input: {
    code: WallieActionErrorCode;
    message: string;
    missingSecretKeys?: string[];
    statusCode: number;
  }) {
    super(input.message);
    this.code = input.code;
    this.missingSecretKeys = input.missingSecretKeys;
    this.name = "WallieActionError";
    this.statusCode = input.statusCode;
  }
}

export type EnqueueWallieRunResult = {
  created: boolean;
  jobId: string | null;
  run: AgentRunRow;
};

export type ProcessQueuedJobsResult = {
  jobId: string | null;
  processed: boolean;
  result: "error" | "idle" | "success";
  runId: string | null;
};

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isUniqueViolation(error: PostgrestError | null) {
  return error?.code === "23505";
}

function toBlockingActionError(reasons: WallieBlockingReason[], missingSecretKeys: string[]) {
  const blockingReason = reasons.find((reason) => reason.code !== "active_run");

  if (!blockingReason) {
    return null;
  }

  return new WallieActionError({
    code: blockingReason.code,
    message: reasons.map((reason) => reason.message).join(" "),
    missingSecretKeys: blockingReason.code === "missing_secret" ? missingSecretKeys : undefined,
    statusCode: 422,
  });
}

function mapRepositoryForRun(repository: RepositoryForRun): WallieIssueRepository {
  return {
    defaultBranch: repository.default_branch,
    defaultProgrammingLanguage: repository.default_programming_language,
    fullName: repository.full_name,
    htmlUrl: repository.html_url,
    id: repository.id,
    isArchived: repository.is_archived,
    isPrivate: repository.private,
  };
}

function createRunInsert(input: {
  sessionId: string;
  jobId: string;
  modelName: string;
  modelProvider: string;
  requestedByMemberId: string;
  runType: WallieRunMode;
  workspaceId: string;
}): TablesInsert<"agent_runs"> {
  return {
    agent_job_id: input.jobId,
    session_id: input.sessionId,
    model_name: input.modelName,
    model_provider: input.modelProvider,
    run_type: input.runType,
    triggered_by_member_id: input.requestedByMemberId,
    workspace_id: input.workspaceId,
  };
}

function createJobInsert(input: {
  sessionId: string;
  requestedByMemberId: string;
  triggerType: Enums<"agent_trigger_type">;
  workspaceId: string;
}): TablesInsert<"agent_jobs"> {
  return {
    dedupe_key: buildWallieJobDedupeKey(input.sessionId),
    session_id: input.sessionId,
    requested_by_member_id: input.requestedByMemberId,
    trigger_type: input.triggerType,
    workspace_id: input.workspaceId,
  };
}

async function loadSessionForRun(
  supabase: SupabaseServerClient,
  sessionId: string | null,
  workspaceId: string,
): Promise<SessionForRun | null> {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from("sessions")
    .select(sessionSelect)
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  // Sessions don't own a repo link directly; derive from the most recent PR
  // branch recorded against this session. The session detail page orders
  // session_pull_requests newest-first, so matching here keeps the run's
  // repo context consistent with what the UI shows. Absent → project mode.
  const { data: branchRow, error: branchError } = await supabase
    .from("session_pull_requests")
    .select("github_repository_id")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (branchError) {
    throw branchError;
  }

  return {
    ...(data as Pick<
      Tables<"sessions">,
      "created_at" | "id" | "number" | "prompt_md" | "title" | "workspace_id"
    >),
    github_repository_id: branchRow?.github_repository_id ?? null,
  };
}

async function loadRepositoryForRun(
  admin: AdminClient,
  workspaceId: string,
  repositoryId: string | null,
) {
  if (!repositoryId) {
    return null;
  }

  const { data, error } = await admin
    .from("github_repositories")
    .select(repositorySelect)
    .eq("id", repositoryId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapRepositoryForRun(data as RepositoryForRun) : null;
}

async function loadMissingSecretKeys(admin: AdminClient, workspaceId: string) {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("key")
    .eq("workspace_id", workspaceId)
    .in("key", [...WALLIE_REQUIRED_SECRET_KEYS]);

  if (error) {
    throw error;
  }

  const availableKeys = new Set((data ?? []).map((secret) => secret.key));

  return [...WALLIE_REQUIRED_SECRET_KEYS].filter((secretKey) => !availableKeys.has(secretKey));
}

async function loadActiveRunForSession(admin: AdminClient, sessionId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("session_id", sessionId)
    .in("status", ["queued", "started", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentRunRow | null;
}

async function loadJobById(admin: AdminClient, jobId: string) {
  const { data, error } = await admin
    .from("agent_jobs")
    .select(jobSelect)
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentJobRow | null;
}

async function loadActiveJobByDedupeKey(
  admin: AdminClient,
  workspaceId: string,
  dedupeKey: string,
) {
  const { data, error } = await admin
    .from("agent_jobs")
    .select(jobSelect)
    .eq("workspace_id", workspaceId)
    .eq("dedupe_key", dedupeKey)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentJobRow | null;
}

async function loadRunById(admin: AdminClient, runId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentRunRow | null;
}

async function loadRunByJobId(admin: AdminClient, jobId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("agent_job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentRunRow | null;
}

async function waitForRunByJobId(admin: AdminClient, jobId: string, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await loadRunByJobId(admin, jobId);

    if (run) {
      return run;
    }

    await delay(40);
  }

  return null;
}

async function validateQueuedRunRequest(input: {
  admin: AdminClient;
  sessionId: string | null;
  requestedRunType?: WallieRunMode;
  supabase: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const session = await loadSessionForRun(input.supabase, input.sessionId, input.workspace.id);

  if (!session) {
    throw new WallieActionError({
      code: "issue_not_found",
      message: "Session not found.",
      statusCode: 404,
    });
  }

  const workspace = input.workspace;
  const runType = input.requestedRunType ?? inferWallieRunMode(session.github_repository_id);
  const [repository, missingSecretKeys, activeRun] = await Promise.all([
    loadRepositoryForRun(input.admin, workspace.id, session.github_repository_id),
    loadMissingSecretKeys(input.admin, workspace.id),
    loadActiveRunForSession(input.admin, session.id),
  ]);

  if (activeRun) {
    return {
      activeRun,
      session,
      repository,
      runType,
      workspace,
    };
  }

  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: false,
    missingSecretKeys,
    mode: runType,
    repository,
  });
  const blockingError = toBlockingActionError(blockingReasons, missingSecretKeys);

  if (blockingError) {
    throw blockingError;
  }

  return {
    activeRun,
    session,
    repository,
    runType,
    workspace,
  };
}

async function cleanupQueuedJob(admin: AdminClient, jobId: string) {
  const { error } = await admin.from("agent_jobs").delete().eq("id", jobId).eq("status", "queued");

  if (error) {
    console.error("Failed to clean up orphaned Wallie job", {
      error,
      jobId,
    });
  }
}

async function createQueuedRun(input: {
  admin: AdminClient;
  session: SessionForRun;
  requestedByMemberId: string;
  runType: WallieRunMode;
  triggerType: Enums<"agent_trigger_type">;
  workspace: WorkspaceAccessWorkspace;
}) {
  // Resolve the workspace's configured model so the queued row matches what
  // the executor will actually run. Source-of-truth is the same lookup
  // pipeline/processor.ts uses; drift between the two re-introduces the
  // original placeholder bug. Resolved BEFORE the job insert so the
  // duplicate-enqueue path (unique-violation → waitForRunByJobId) doesn't
  // race against this query — `waitForRunByJobId` only retries for ~200ms,
  // and any extra latency between job insert and run insert eats into that
  // window.
  const agentConfig = await loadWorkspaceAgentConfig(input.admin, input.workspace.id);

  const jobInsert = createJobInsert({
    sessionId: input.session.id,
    requestedByMemberId: input.requestedByMemberId,
    triggerType: input.triggerType,
    workspaceId: input.workspace.id,
  });
  const { data: job, error: jobError } = await input.admin
    .from("agent_jobs")
    .insert(jobInsert)
    .select(jobSelect)
    .single();

  if (isUniqueViolation(jobError)) {
    const activeJob = await loadActiveJobByDedupeKey(
      input.admin,
      input.workspace.id,
      buildWallieJobDedupeKey(input.session.id),
    );

    if (!activeJob) {
      throw jobError;
    }

    const activeRun = await waitForRunByJobId(input.admin, activeJob.id);

    if (!activeRun) {
      throw jobError;
    }

    return {
      created: false,
      jobId: activeJob.id,
      run: activeRun,
    } satisfies EnqueueWallieRunResult;
  }

  if (jobError) {
    throw jobError;
  }

  const { data: run, error: runError } = await input.admin
    .from("agent_runs")
    .insert(
      createRunInsert({
        sessionId: input.session.id,
        jobId: job.id,
        modelName: agentConfig.model,
        modelProvider: agentConfig.provider,
        requestedByMemberId: input.requestedByMemberId,
        runType: input.runType,
        workspaceId: input.workspace.id,
      }),
    )
    .select(runSelect)
    .single();

  if (runError) {
    await cleanupQueuedJob(input.admin, job.id);
    throw runError;
  }

  return {
    created: true,
    jobId: job.id,
    run,
  } satisfies EnqueueWallieRunResult;
}

export async function enqueueWallieRun(input: {
  admin?: AdminClient;
  sessionId: string;
  requestedByMemberId: string;
  supabase: SupabaseServerClient;
  triggerType: Enums<"agent_trigger_type">;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const validated = await validateQueuedRunRequest({
    admin,
    sessionId: input.sessionId,
    supabase: input.supabase,
    workspace: input.workspace,
  });

  if (validated.activeRun) {
    return {
      created: false,
      jobId: validated.activeRun.agent_job_id,
      run: validated.activeRun,
    } satisfies EnqueueWallieRunResult;
  }

  return createQueuedRun({
    admin,
    session: validated.session,
    requestedByMemberId: input.requestedByMemberId,
    runType: validated.runType,
    triggerType: input.triggerType,
    workspace: validated.workspace,
  });
}

export async function retryWallieRun(input: {
  admin?: AdminClient;
  requestedByMemberId: string;
  runId: string;
  supabase: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const existingRun = await loadRunById(admin, input.runId);

  if (!existingRun || existingRun.workspace_id !== input.workspace.id) {
    throw new WallieActionError({
      code: "run_not_found",
      message: "Wallie run not found.",
      statusCode: 404,
    });
  }

  if (!["success", "error", "canceled"].includes(existingRun.status)) {
    throw new WallieActionError({
      code: "run_not_retryable",
      message: "Only completed or failed Wallie runs can be retried.",
      statusCode: 409,
    });
  }

  const validated = await validateQueuedRunRequest({
    admin,
    sessionId: existingRun.session_id,
    requestedRunType: parseWallieRunMode(existingRun.run_type),
    supabase: input.supabase,
    workspace: input.workspace,
  });

  if (validated.activeRun) {
    return {
      created: false,
      jobId: validated.activeRun.agent_job_id,
      run: validated.activeRun,
    } satisfies EnqueueWallieRunResult;
  }

  return createQueuedRun({
    admin,
    session: validated.session,
    requestedByMemberId: input.requestedByMemberId,
    runType: validated.runType,
    triggerType: "manual_retry",
    workspace: validated.workspace,
  });
}

async function claimJobIfQueued(admin: AdminClient, job: AgentJobRow) {
  if (job.status === "running") {
    return job;
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .update({
      attempt_count: job.attempt_count + 1,
      last_error: null,
      started_at: job.started_at ?? new Date().toISOString(),
      status: "running",
    })
    .eq("id", job.id)
    .eq("status", "queued")
    .select(jobSelect)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as AgentJobRow | null) ?? null;
}

export async function claimQueuedJobCandidate<TJob extends { id: string }>(
  candidates: readonly TJob[],
  claim: (job: TJob) => Promise<TJob | null>,
) {
  for (const candidate of candidates) {
    const claimed = await claim(candidate);

    if (claimed) {
      return claimed;
    }
  }

  return null;
}

async function loadProcessTargetJob(input: {
  admin: AdminClient;
  requestedJobId?: string;
  workspaceId?: string;
}) {
  if (input.requestedJobId) {
    const job = await loadJobById(input.admin, input.requestedJobId);

    if (!job || (job.status !== "queued" && job.status !== "running")) {
      return null;
    }

    if (input.workspaceId && job.workspace_id !== input.workspaceId) {
      return null;
    }

    if (job.status === "running") {
      // Pipeline jobs are one-shot and not designed to be re-entered
      // concurrently — the processor would regenerate the spec and double-
      // post to Slack. Refuse to re-dispatch a running job. Stuck rows
      // (processor crash mid-flight) are recovered manually for now.
      return null;
    }

    return claimJobIfQueued(input.admin, job);
  }

  // Only claim jobs that are either not scheduled or whose scheduled_at is
  // in the past (exponential backoff — jobs re-queued with a future
  // scheduled_at must wait until that time elapses).
  const now = new Date().toISOString();
  const query = input.admin
    .from("agent_jobs")
    .select(jobSelect)
    .eq("status", "queued")
    .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(10);
  const scopedQuery = input.workspaceId ? query.eq("workspace_id", input.workspaceId) : query;
  const { data, error } = await scopedQuery;

  if (error) {
    throw error;
  }

  return claimQueuedJobCandidate((data ?? []) as AgentJobRow[], async (job) =>
    claimJobIfQueued(input.admin, job),
  );
}

async function processClaimedJob(input: { admin: AdminClient; job: AgentJobRow }) {
  return processPipelineJob({ admin: input.admin, job: input.job });
}

export async function processQueuedAgentJobs(input?: {
  admin?: AdminClient;
  requestedJobId?: string;
  workspaceId?: string;
}) {
  const admin = input?.admin ?? createSupabaseAdminClient();
  const claimedJob = await loadProcessTargetJob({
    admin,
    requestedJobId: input?.requestedJobId,
    workspaceId: input?.workspaceId,
  });

  if (!claimedJob) {
    return {
      jobId: null,
      processed: false,
      result: "idle",
      runId: null,
    } satisfies ProcessQueuedJobsResult;
  }

  return processClaimedJob({
    admin,
    job: claimedJob,
  });
}
