import type {
  PipelineMutationOwner,
  PipelineOperation,
  PipelineRecoveryReadOwner,
  PipelineRpcOwner,
  PipelineSqlFileOwner,
  PipelineTable,
  PipelineTransitionBoundaryConfig,
  RecoveryCategory,
} from "./verify-pipeline-transitions";

const TRANSITIONS = "src/lib/pipeline/transitions.ts";
const PROCESSOR = "src/lib/pipeline/processor.ts";
const WALLIE = "src/lib/wallie/service.ts";
const CANCEL = "src/lib/pipeline/cancel.ts";
const RECONCILER = "src/worker/reconciler.ts";
const STALL_DETECTOR = "src/worker/stall-detector.ts";
const WORKER_LOOP = "src/worker/loop.ts";

const CANONICAL_SESSION_API =
  "Use the typed session transition in @/lib/pipeline/transitions or a named transactional RPC.";
const CANONICAL_JOB_API =
  "Use the typed job transition in @/lib/pipeline/transitions or a named transactional RPC.";
const CANONICAL_RUN_API = "Use the typed run transition in @/lib/pipeline/transitions.";
const CANONICAL_ARTIFACT_API = "Use the typed artifact transition in @/lib/pipeline/transitions.";

function owner(
  functionName: string,
  table: PipelineTable,
  operation: Exclude<PipelineOperation, "select">,
  callers: readonly string[],
  recovery?: RecoveryCategory,
): PipelineMutationOwner {
  const canonicalApi =
    table === "sessions"
      ? CANONICAL_SESSION_API
      : table === "agent_jobs"
        ? CANONICAL_JOB_API
        : table === "agent_runs"
          ? CANONICAL_RUN_API
          : CANONICAL_ARTIFACT_API;
  return {
    callers,
    canonicalApi,
    functionName,
    operation,
    path: TRANSITIONS,
    ...(recovery ? { recovery } : {}),
    table,
  };
}

const mutationOwners = [
  owner("claimSessionForGeneration", "sessions", "update", [PROCESSOR]),
  owner("publishGeneratedArtifact", "sessions", "update", [PROCESSOR]),
  owner("restoreGeneratingSessionPhase", "sessions", "update", [PROCESSOR]),
  owner("restorePublishedSessionAfterFailure", "sessions", "update", [PROCESSOR]),
  owner("claimSessionRejection", "sessions", "update", [PROCESSOR]),
  owner("publishRejectedSession", "sessions", "update", [PROCESSOR]),
  owner("archiveSessionMarker", "sessions", "update", ["src/lib/pipeline/archive.ts"]),
  owner("unarchiveSessionMarker", "sessions", "update", ["src/lib/pipeline/archive.ts"]),
  owner("parkCanceledSession", "sessions", "update", [CANCEL], "cancellation"),
  owner("archiveSessionForReconciler", "sessions", "update", [RECONCILER], "reconciler"),
  owner("rerouteSessionForReconciler", "sessions", "update", [RECONCILER], "reconciler"),
  owner("parkStalledSession", "sessions", "update", [STALL_DETECTOR], "stall-detector"),
  owner(
    "parkWorkspaceSessionsAfterDeleteFailure",
    "sessions",
    "update",
    ["src/app/api/workspaces/[workspaceId]/route.ts"],
    "repair",
  ),
  owner("updateSessionTitleMetadata", "sessions", "update", [
    "src/app/api/sessions/[sessionId]/route.ts",
  ]),
  owner("insertSessionArtifact", "session_artifacts", "insert", [PROCESSOR]),
  owner("deleteSessionArtifactVersion", "session_artifacts", "delete", [PROCESSOR]),
  owner(
    "deleteSessionArtifactsForStages",
    "session_artifacts",
    "delete",
    [RECONCILER],
    "reconciler",
  ),
  owner("insertSessionArtifactFeedback", "session_artifact_feedback", "insert", [PROCESSOR]),
  owner(
    "deleteSessionArtifactFeedbackForStages",
    "session_artifact_feedback",
    "delete",
    [RECONCILER],
    "reconciler",
  ),
  owner(
    "deleteSessionPhaseCompletionsForStages",
    "session_phase_completions",
    "delete",
    [RECONCILER],
    "reconciler",
  ),
  owner("createQueuedAgentJob", "agent_jobs", "insert", [PROCESSOR]),
  owner("createQueuedAgentJobRecord", "agent_jobs", "insert", [WALLIE]),
  owner("enqueueQueuedAgentJob", "agent_jobs", "insert", [RECONCILER], "reconciler"),
  owner("deleteQueuedAgentJob", "agent_jobs", "delete", [PROCESSOR, WALLIE]),
  owner("claimQueuedAgentJob", "agent_jobs", "update", [WALLIE]),
  owner("completeAgentJob", "agent_jobs", "update", [PROCESSOR, WORKER_LOOP]),
  owner("errorRunningAgentJob", "agent_jobs", "update", [STALL_DETECTOR], "stall-detector"),
  owner("recordAgentJobError", "agent_jobs", "update", [PROCESSOR, STALL_DETECTOR]),
  owner("cancelSessionAgentJobs", "agent_jobs", "update", [CANCEL], "cancellation"),
  owner("cancelWorkspaceAgentJobs", "agent_jobs", "update", [CANCEL], "cancellation"),
  owner("createQueuedAgentRun", "agent_runs", "insert", [WALLIE]),
  owner("enqueueQueuedAgentRun", "agent_runs", "insert", [PROCESSOR]),
  owner("startAgentRun", "agent_runs", "update", [PROCESSOR]),
  owner("startAgentRun", "agent_runs", "insert", [PROCESSOR]),
  owner("attachRunSandbox", "agent_runs", "update", [PROCESSOR]),
  owner("completeAgentRun", "agent_runs", "update", [PROCESSOR]),
  owner("cancelActiveRunsForJob", "agent_runs", "update", [PROCESSOR]),
  owner("errorActiveRunsForJob", "agent_runs", "update", [PROCESSOR]),
  owner("touchActiveRun", "agent_runs", "update", [PROCESSOR]),
  owner("touchActiveRunsForJob", "agent_runs", "update", [WORKER_LOOP]),
  owner("errorStalledRun", "agent_runs", "update", [STALL_DETECTOR], "stall-detector"),
  owner("cancelSessionAgentRuns", "agent_runs", "update", [CANCEL], "cancellation"),
  owner("cancelWorkspaceAgentRuns", "agent_runs", "update", [CANCEL], "cancellation"),
] as const satisfies readonly PipelineMutationOwner[];

const rpcOwners = [
  {
    callers: [PROCESSOR],
    canonicalApi: "Use approveSessionStage().",
    functionName: "approveSessionStage",
    latestMigration: "supabase/migrations/20260722000000_any_workspace_member_stage_approval.sql",
    path: TRANSITIONS,
    rpc: "approve_session_stage",
  },
  {
    callers: [WORKER_LOOP],
    canonicalApi: "Use claimNextAgentJob().",
    functionName: "claimNextAgentJob",
    latestMigration: "supabase/migrations/20260721000001_add_e2b_daytona_sandbox_providers.sql",
    path: TRANSITIONS,
    rpc: "claim_next_agent_job",
  },
  {
    callers: [WALLIE],
    canonicalApi: "Use createSessionWithFirstJobTransition().",
    functionName: "createSessionWithFirstJobTransition",
    latestMigration: "supabase/migrations/20260718000003_create_session_with_first_job.sql",
    path: TRANSITIONS,
    rpc: "create_session_with_first_job",
  },
  {
    callers: [PROCESSOR, STALL_DETECTOR],
    canonicalApi: "Use scheduleAgentJobRetry().",
    functionName: "scheduleAgentJobRetry",
    latestMigration: "supabase/migrations/20260607000002_guard_schedule_job_retry.sql",
    path: TRANSITIONS,
    rpc: "schedule_job_retry",
  },
] as const satisfies readonly PipelineRpcOwner[];

const recoveryReadOwners = [
  {
    category: "reaper",
    functionName: "loadKnownConnectionSandboxState",
    path: "src/worker/sandbox-reaper.ts",
    table: "agent_runs",
  },
  {
    category: "reaper",
    functionName: "loadActiveAgentJobIds",
    path: "src/worker/sandbox-reaper.ts",
    table: "agent_jobs",
  },
] as const satisfies readonly PipelineRecoveryReadOwner[];

function sqlOwner(path: string, reason: string): PipelineSqlFileOwner {
  return { owner: "pipeline-maintainers@wallie.dev", path, reason };
}

const sqlFileOwners = [
  sqlOwner("supabase/migrations/20260422000000_init.sql", "Consolidated schema/RPC baseline."),
  sqlOwner(
    "supabase/migrations/20260605000001_add_claim_next_agent_job.sql",
    "Historical worker-claim RPC definition.",
  ),
  sqlOwner(
    "supabase/migrations/20260606000000_pipeline_symphony_alignment.sql",
    "Historical pipeline schema/default adapter migration.",
  ),
  sqlOwner(
    "supabase/migrations/20260606000001_add_vercel_sandbox_connections.sql",
    "Historical claim RPC and sandbox lifecycle migration.",
  ),
  sqlOwner(
    "supabase/migrations/20260607000000_worker_heartbeat_active_job_ids.sql",
    "Worker heartbeat recovery schema migration.",
  ),
  sqlOwner(
    "supabase/migrations/20260607000002_guard_schedule_job_retry.sql",
    "Effective transactional job-retry owner.",
  ),
  sqlOwner(
    "supabase/migrations/20260607000004_guard_approve_session_stage_on_archive.sql",
    "Historical stage-approval RPC definition.",
  ),
  sqlOwner(
    "supabase/migrations/20260622000000_sessions_latency_indexes.sql",
    "Session read-model functions and indexes.",
  ),
  sqlOwner(
    "supabase/migrations/20260717000000_allow_member_session_title_updates.sql",
    "Session metadata policy/trigger migration.",
  ),
  sqlOwner(
    "supabase/migrations/20260717000002_pipeline_dashboard_page.sql",
    "Pipeline dashboard read model.",
  ),
  sqlOwner(
    "supabase/migrations/20260717000003_add_workspace_usage_aggregate.sql",
    "Workspace usage read model.",
  ),
  sqlOwner(
    "supabase/migrations/20260718000001_narrow_session_detail_page.sql",
    "Session detail read model.",
  ),
  sqlOwner(
    "supabase/migrations/20260718000002_realtime_delete_replica_identity.sql",
    "Realtime replica identity ownership.",
  ),
  sqlOwner(
    "supabase/migrations/20260718000003_create_session_with_first_job.sql",
    "Transactional session/job/run creation owner.",
  ),
  sqlOwner(
    "supabase/migrations/20260718000004_sessions_list_sort_and_repository.sql",
    "Session list read model.",
  ),
  sqlOwner(
    "supabase/migrations/20260721000000_remove_has_pr_filter.sql",
    "Pipeline dashboard read-model replacement.",
  ),
  sqlOwner(
    "supabase/migrations/20260721000001_add_e2b_daytona_sandbox_providers.sql",
    "Effective worker-claim RPC and owned sandbox routing backfill.",
  ),
  sqlOwner(
    "supabase/migrations/20260722000000_any_workspace_member_stage_approval.sql",
    "Effective transactional stage-approval owner.",
  ),
] as const;

const seededStageLiteralExceptions = [
  {
    functionName: "reconcileLinearState",
    owner: "linear-routing@wallie.dev",
    path: "src/worker/reconciler.ts",
    reason:
      'The "land" literal is a Linear route action discriminant; the target stage remains route.stageSlug data.',
    value: "land",
  },
  {
    functionName: "jsScriptCommand",
    owner: "repository-inference@wallie.dev",
    path: "src/lib/repo-inference/infer.ts",
    reason: 'The "build" literal is a package.json script name, not a pipeline stage.',
    value: "build",
  },
  {
    functionName: "hasScript",
    owner: "repository-inference@wallie.dev",
    path: "src/lib/repo-inference/infer.ts",
    reason: 'The "build" literal is a package.json script name, not a pipeline stage.',
    value: "build",
  },
  {
    functionName: "inferRepositoryProfileFromFiles",
    owner: "repository-inference@wallie.dev",
    path: "src/lib/repo-inference/infer.ts",
    reason: 'The "build" literal selects a package.json script, not a pipeline stage.',
    value: "build",
  },
  ...[
    "supabase/migrations/20260422000000_init.sql",
    "supabase/migrations/20260606000000_pipeline_symphony_alignment.sql",
    "supabase/migrations/20260606000002_no_screenshot_commits.sql",
    "supabase/migrations/20260607000003_screenshot_proof_commit_links.sql",
  ].flatMap((path) =>
    ["plan", "build", "land"].map((value) => ({
      functionName: "default_pipeline_stages",
      owner: "pipeline-defaults@wallie.dev",
      path,
      reason:
        "The historical default-stage adapter defines seeded workspace defaults; runtime stage transitions remain data-driven.",
      value,
    })),
  ),
];

const importCallers = new Map<string, Set<string>>();
for (const owner of [...mutationOwners, ...rpcOwners]) {
  const callers = importCallers.get(owner.functionName) ?? new Set<string>();
  owner.callers.forEach((caller) => callers.add(caller));
  importCallers.set(owner.functionName, callers);
}

export const pipelineTransitionBoundaryConfig = {
  dynamicTableExceptions: [
    {
      functionName: "DELETE",
      owner: "sandbox-connections@wallie.dev",
      path: "src/app/api/workspaces/[workspaceId]/sandbox-connections/[provider]/route.ts",
      reason:
        "The provider enum selects one of three non-lifecycle connection tables before deletion.",
    },
  ],
  genericStageSourceRoots: ["src"],
  importPermissions: [...importCallers.entries()].map(([name, callers]) => ({
    callers: [...callers].sort(),
    name,
  })),
  mutationOwners,
  protectedTables: [
    "agent_jobs",
    "agent_runs",
    "session_artifact_feedback",
    "session_artifacts",
    "session_phase_completions",
    "sessions",
  ],
  recoveryReadOwners,
  rpcOwners,
  seededStageAdapters: [
    "src/app/dev/pipeline-editor/preview-client.tsx",
    "src/app/dev/sessions-ledger/page.tsx",
    "src/components/ui/ui-primitives-showcase.tsx",
    "src/features/pipeline/editor-primitives.tsx",
    "src/features/pipeline/pipeline-board-fixture.tsx",
    "src/features/sessions/detail/artifact-fixtures.ts",
    "src/features/sessions/detail/artifact-reader-fixture.tsx",
    "src/features/wallie/wallie-activity-fixture.tsx",
    "src/lib/linear-routing/contracts.ts",
    "src/lib/pipeline/defaults.ts",
    "src/lib/repo-onboarding/skills.ts",
  ],
  seededStageLiteralExceptions,
  seededStageSlugs: ["build", "land", "plan"],
  sourceRoots: ["src", "supabase/migrations"],
  sqlFileOwners,
  transitionModule: "@/lib/pipeline/transitions",
} satisfies PipelineTransitionBoundaryConfig;
