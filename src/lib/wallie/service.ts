import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Enums, Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";
import { PIPELINE_JOB_TYPE } from "@/lib/pipeline/types";
import {
  buildWallieBlockingReasons,
  inferWallieRunMode,
  parseWallieRunMode,
} from "@/lib/wallie/core";
import {
  buildWallieJobDedupeKey,
  WALLIE_MODEL_NAME,
  WALLIE_MODEL_PROVIDER,
  WALLIE_REQUIRED_SECRET_KEYS,
} from "@/lib/wallie/constants";
import {
  buildStubBranchName,
  executeStubWallieRun,
  type StubCodeArtifacts,
  type StubProjectArtifacts,
} from "@/lib/wallie/executor";
import type {
  WallieActionErrorCode,
  WallieBlockingReason,
  WallieRunMode,
} from "@/lib/wallie/types";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type WorkspaceAccessWorkspace = Pick<Tables<"workspaces">, "id" | "name" | "slug">;
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type IssueForRun = Pick<
  Tables<"issues">,
  | "created_at"
  | "description_md"
  | "github_repository_id"
  | "id"
  | "number"
  | "title"
  | "workspace_id"
>;
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

const issueSelect =
  "id, workspace_id, number, title, description_md, github_repository_id, created_at";
const workspaceSelect = "id, name, slug";
const repositorySelect =
  "id, workspace_id, full_name, html_url, private, default_programming_language, default_branch, is_archived";
const jobSelect =
  "id, workspace_id, issue_id, requested_by_member_id, trigger_type, status, attempt_count, last_error, dedupe_key, job_type, scheduled_at, started_at, finished_at, created_at, updated_at";
const runSelect =
  "id, workspace_id, issue_id, agent_job_id, triggered_by_member_id, run_type, model_provider, model_name, status, started_at, finished_at, created_at, updated_at";

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

function createRunInsert(input: {
  issueId: string;
  jobId: string;
  requestedByMemberId: string;
  runType: WallieRunMode;
  workspaceId: string;
}): TablesInsert<"agent_runs"> {
  return {
    agent_job_id: input.jobId,
    issue_id: input.issueId,
    model_name: WALLIE_MODEL_NAME,
    model_provider: WALLIE_MODEL_PROVIDER,
    run_type: input.runType,
    triggered_by_member_id: input.requestedByMemberId,
    workspace_id: input.workspaceId,
  };
}

function createJobInsert(input: {
  issueId: string;
  requestedByMemberId: string;
  triggerType: Enums<"agent_trigger_type">;
  workspaceId: string;
}): TablesInsert<"agent_jobs"> {
  return {
    dedupe_key: buildWallieJobDedupeKey(input.issueId),
    issue_id: input.issueId,
    requested_by_member_id: input.requestedByMemberId,
    trigger_type: input.triggerType,
    workspace_id: input.workspaceId,
  };
}

async function loadIssueForRun(
  supabase: SupabaseServerClient,
  issueId: string,
  workspaceId: string,
) {
  const { data, error } = await supabase
    .from("issues")
    .select(issueSelect)
    .eq("id", issueId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as IssueForRun | null;
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

  return data as RepositoryForRun | null;
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

async function loadActiveRunForIssue(admin: AdminClient, issueId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("issue_id", issueId)
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
  issueId: string;
  requestedRunType?: WallieRunMode;
  supabase: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const issue = await loadIssueForRun(input.supabase, input.issueId, input.workspace.id);

  if (!issue) {
    throw new WallieActionError({
      code: "issue_not_found",
      message: "Issue not found.",
      statusCode: 404,
    });
  }

  const workspace = input.workspace;
  const runType = input.requestedRunType ?? inferWallieRunMode(issue.github_repository_id);
  const [repository, missingSecretKeys, activeRun] = await Promise.all([
    loadRepositoryForRun(input.admin, workspace.id, issue.github_repository_id),
    loadMissingSecretKeys(input.admin, workspace.id),
    loadActiveRunForIssue(input.admin, issue.id),
  ]);

  if (activeRun) {
    return {
      activeRun,
      issue,
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
    issue,
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
  issue: IssueForRun;
  requestedByMemberId: string;
  runType: WallieRunMode;
  triggerType: Enums<"agent_trigger_type">;
  workspace: WorkspaceAccessWorkspace;
}) {
  const jobInsert = createJobInsert({
    issueId: input.issue.id,
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
      buildWallieJobDedupeKey(input.issue.id),
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
        issueId: input.issue.id,
        jobId: job.id,
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
  issueId: string;
  requestedByMemberId: string;
  supabase: SupabaseServerClient;
  triggerType: Enums<"agent_trigger_type">;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const validated = await validateQueuedRunRequest({
    admin,
    issueId: input.issueId,
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
    issue: validated.issue,
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
    issueId: existingRun.issue_id,
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
    issue: validated.issue,
    requestedByMemberId: input.requestedByMemberId,
    runType: validated.runType,
    triggerType: "manual_retry",
    workspace: validated.workspace,
  });
}

async function appendRunMessageIfMissing(input: {
  admin: AdminClient;
  kind: string;
  message: string;
  runId: string;
  workspaceId: string;
}) {
  const { data: existingMessage, error: existingMessageError } = await input.admin
    .from("agent_run_messages")
    .select("id")
    .eq("agent_run_id", input.runId)
    .eq("kind", input.kind)
    .eq("message_md", input.message)
    .maybeSingle();

  if (existingMessageError) {
    throw existingMessageError;
  }

  if (existingMessage) {
    return existingMessage.id;
  }

  const { data, error } = await input.admin
    .from("agent_run_messages")
    .insert({
      agent_run_id: input.runId,
      kind: input.kind,
      message_md: input.message,
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return data.id;
}

async function updateRunStatusIfNeeded(
  admin: AdminClient,
  run: AgentRunRow,
  patch: TablesUpdate<"agent_runs">,
  expectedStatuses: Enums<"agent_run_status">[],
) {
  const query = admin
    .from("agent_runs")
    .update(patch)
    .eq("id", run.id)
    .in("status", expectedStatuses)
    .select(runSelect)
    .maybeSingle();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return (data as AgentRunRow | null) ?? run;
}

async function ensureRunStarted(admin: AdminClient, run: AgentRunRow) {
  if (run.status !== "queued") {
    return run;
  }

  return updateRunStatusIfNeeded(
    admin,
    run,
    {
      started_at: run.started_at ?? new Date().toISOString(),
      status: "started",
    },
    ["queued"],
  );
}

async function ensureRunRunning(admin: AdminClient, run: AgentRunRow) {
  if (run.status === "running") {
    return run;
  }

  if (run.status === "success" || run.status === "error" || run.status === "canceled") {
    return run;
  }

  return updateRunStatusIfNeeded(
    admin,
    run,
    {
      started_at: run.started_at ?? new Date().toISOString(),
      status: "running",
    },
    ["queued", "started"],
  );
}

async function markJobTerminal(input: {
  admin: AdminClient;
  errorMessage?: string | null;
  job: AgentJobRow;
  status: Enums<"agent_job_status">;
}) {
  const { error } = await input.admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: input.status === "error" ? (input.errorMessage ?? "Wallie run failed.") : null,
      status: input.status,
    })
    .eq("id", input.job.id)
    .neq("status", input.status);

  if (error) {
    throw error;
  }
}

async function finalizeRunError(input: {
  admin: AdminClient;
  errorMessage: string;
  job: AgentJobRow;
  run: AgentRunRow;
}) {
  const finishedAt = new Date().toISOString();
  const { error } = await input.admin
    .from("agent_runs")
    .update({
      finished_at: finishedAt,
      status: "error",
    })
    .eq("id", input.run.id)
    .in("status", ["queued", "started", "running"]);

  if (error) {
    throw error;
  }

  await markJobTerminal({
    admin: input.admin,
    errorMessage: input.errorMessage,
    job: input.job,
    status: "error",
  });
}

async function finalizeRunSuccess(input: {
  admin: AdminClient;
  job: AgentJobRow;
  run: AgentRunRow;
}) {
  const { error } = await input.admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success",
    })
    .eq("id", input.run.id)
    .neq("status", "success");

  if (error) {
    throw error;
  }

  await markJobTerminal({
    admin: input.admin,
    job: input.job,
    status: "success",
  });
}

// The classical tracker persisted stub wallie project artifacts into
// issues.design_md / issues.plan_md. Those columns were dropped in PR 4 —
// the stub executor still produces the strings (the runner log references
// them), but we no longer have a place to store them on the anchor issue.
// The wallie stub mode is scheduled for a full rewrite onto sessions in a
// follow-up; until then, this is a no-op so the runner contract still
// holds. The prefix underscore tells ESLint the destructured members are
// intentional-unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function persistProjectArtifacts(_: {
  admin: AdminClient;
  artifacts: StubProjectArtifacts;
  issueId: string;
}) {
  return;
}

async function persistCodeArtifacts(input: {
  admin: AdminClient;
  artifacts: StubCodeArtifacts;
  issueId: string;
  workspaceId: string;
}) {
  const { data: existingBranch, error: existingBranchError } = await input.admin
    .from("github_issue_branches")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("issue_id", input.issueId)
    .eq("github_repository_id", input.artifacts.githubRepositoryId)
    .eq("branch_name", input.artifacts.branchName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingBranchError) {
    throw existingBranchError;
  }

  if (existingBranch) {
    return existingBranch.id;
  }

  const { data, error } = await input.admin
    .from("github_issue_branches")
    .insert({
      branch_name: input.artifacts.branchName,
      github_repository_id: input.artifacts.githubRepositoryId,
      is_draft: true,
      issue_id: input.issueId,
      pull_request_state: "stubbed",
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return data.id;
}

async function loadWorkspaceForJob(admin: AdminClient, workspaceId: string) {
  const { data, error } = await admin
    .from("workspaces")
    .select(workspaceSelect)
    .eq("id", workspaceId)
    .single();

  if (error) {
    throw error;
  }

  return data as WorkspaceAccessWorkspace;
}

async function loadIssueById(admin: AdminClient, issueId: string) {
  const { data, error } = await admin.from("issues").select(issueSelect).eq("id", issueId).single();

  if (error) {
    throw error;
  }

  return data as IssueForRun;
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
      // Wallie jobs can resume a running row (long-running codegen pauses and
      // a later trigger picks up where it left off). Pipeline jobs are one-
      // shot and not designed to be re-entered concurrently — the processor
      // would regenerate the spec and double-post to Slack. Refuse to re-
      // dispatch a running pipeline job. Stuck rows (processor crash mid-
      // flight) are recovered manually for now.
      if (job.job_type === PIPELINE_JOB_TYPE) {
        return null;
      }
      return job;
    }

    return claimJobIfQueued(input.admin, job);
  }

  const query = input.admin
    .from("agent_jobs")
    .select(jobSelect)
    .eq("status", "queued")
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
  // Dispatch pipeline jobs to the pipeline processor before wallie-specific code
  if (input.job.job_type === PIPELINE_JOB_TYPE) {
    return processPipelineJob({ admin: input.admin, job: input.job });
  }

  const run = await loadRunByJobId(input.admin, input.job.id);

  if (!run) {
    await markJobTerminal({
      admin: input.admin,
      errorMessage: "Wallie could not find the run row for the queued job.",
      job: input.job,
      status: "error",
    });

    return {
      jobId: input.job.id,
      processed: true,
      result: "error",
      runId: null,
    } satisfies ProcessQueuedJobsResult;
  }

  if (run.status === "success") {
    await markJobTerminal({
      admin: input.admin,
      job: input.job,
      status: "success",
    });

    return {
      jobId: input.job.id,
      processed: true,
      result: "success",
      runId: run.id,
    } satisfies ProcessQueuedJobsResult;
  }

  if (run.status === "error" || run.status === "canceled") {
    await markJobTerminal({
      admin: input.admin,
      errorMessage: run.status === "error" ? input.job.last_error : null,
      job: input.job,
      status: run.status === "error" ? "error" : "canceled",
    });

    return {
      jobId: input.job.id,
      processed: true,
      result: run.status === "error" ? "error" : "success",
      runId: run.id,
    } satisfies ProcessQueuedJobsResult;
  }

  const [workspace, issue] = await Promise.all([
    loadWorkspaceForJob(input.admin, input.job.workspace_id),
    loadIssueById(input.admin, input.job.issue_id),
  ]);
  const repository = await loadRepositoryForRun(
    input.admin,
    workspace.id,
    issue.github_repository_id,
  );

  let currentRun = await ensureRunStarted(input.admin, run);

  const appendMessage = async (kind: "error" | "output" | "status", message: string) => {
    await appendRunMessageIfMissing({
      admin: input.admin,
      kind,
      message,
      runId: currentRun.id,
      workspaceId: currentRun.workspace_id,
    });
  };

  await appendMessage("status", "Wallie control plane claimed this queued run.");

  try {
    currentRun = await ensureRunRunning(input.admin, currentRun);
    await appendMessage("status", "Wallie validated the issue context and entered executor mode.");
    await executeStubWallieRun({
      appendMessage,
      issue: {
        createdAt: issue.created_at,
        descriptionMd: issue.description_md,
        number: issue.number,
        title: issue.title,
      },
      persistCodeArtifacts: async (artifacts) => {
        await persistCodeArtifacts({
          admin: input.admin,
          artifacts,
          issueId: issue.id,
          workspaceId: workspace.id,
        });
      },
      persistProjectArtifacts: async (artifacts) => {
        await persistProjectArtifacts({
          admin: input.admin,
          artifacts,
          issueId: issue.id,
        });
      },
      repository: repository
        ? {
            fullName: repository.full_name,
            id: repository.id,
          }
        : null,
      run: {
        createdAt: currentRun.created_at,
        runType: parseWallieRunMode(
          currentRun.run_type,
          inferWallieRunMode(issue.github_repository_id),
        ),
      },
    });
    await appendMessage(
      "status",
      repository
        ? `Wallie finished successfully. Branch \`${buildStubBranchName(issue.number)}\` is now visible on the issue timeline.`
        : "Wallie finished successfully and updated the issue plan/design fields.",
    );
    await finalizeRunSuccess({
      admin: input.admin,
      job: input.job,
      run: currentRun,
    });

    return {
      jobId: input.job.id,
      processed: true,
      result: "success",
      runId: currentRun.id,
    } satisfies ProcessQueuedJobsResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallie run failed.";

    await appendMessage("error", message);
    await finalizeRunError({
      admin: input.admin,
      errorMessage: message,
      job: input.job,
      run: currentRun,
    });

    return {
      jobId: input.job.id,
      processed: true,
      result: "error",
      runId: currentRun.id,
    } satisfies ProcessQueuedJobsResult;
  }
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
