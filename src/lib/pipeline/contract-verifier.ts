import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";

type ProtectedTable = "agent_jobs" | "agent_runs" | "sessions";
type MutationOperation = "delete" | "insert" | "update" | "upsert";
type PredicateMethod = "eq" | "in" | "is" | "neq" | "not";
type PredicateScalar = boolean | null | number | string;
type PredicateValue = PredicateScalar | readonly PredicateScalar[] | { expression: string };

export type PipelineContractFile = {
  path: string;
  source: string;
};

export type PipelineContractDiagnostic = {
  code: "pipeline-cas" | "pipeline-owner" | "recovery-owner-unused" | "seeded-stage-branch";
  line: number;
  message: string;
  path: string;
};

type TransitionOwner = {
  canonicalApi: string;
  id: string;
  path: string;
  transitions: readonly TransitionPermission[];
};

type TransitionPermission = {
  fields: readonly string[];
  functionName: string;
  operation: MutationOperation;
  requiredPredicates: readonly (readonly PredicateRequirement[])[];
  table: ProtectedTable;
};

type PredicateRequirement = {
  field: string;
  method: PredicateMethod;
  operator?: string;
  value: PredicateValue;
};

type RecoveryOwner = TransitionOwner & {
  category: "cancellation" | "reaper" | "reconciler" | "repair" | "stall-detector";
  requiredFunctions?: readonly string[];
  requiredMarkers?: readonly string[];
};

type SqlTransitionOwner = {
  canonicalApi: string;
  functionName: string;
  id: string;
  signature: string;
  transitions: readonly SqlTransitionPermission[];
};

type SqlMigrationOwner = {
  canonicalApi: string;
  id: string;
  path: string;
  transitions: readonly SqlTransitionPermission[];
};

type SqlTransitionPermission = {
  fields: readonly string[];
  operation: MutationOperation;
  requiredPredicates: readonly SqlPredicateRequirement[];
  table: ProtectedTable;
};

type SqlPredicateRequirement = {
  field: string;
  operator: "=" | "<>" | "!=" | "is" | "is not";
  value: PredicateValue;
};

export type PipelineTransitionContract = {
  defaultAdapterPaths: readonly string[];
  ordinaryOwners: readonly TransitionOwner[];
  protectedFields: Readonly<Record<ProtectedTable, readonly string[]>>;
  recoveryOwners: readonly RecoveryOwner[];
  seededStageSlugs: readonly string[];
  sqlMigrationOwners: readonly SqlMigrationOwner[];
  sqlOwners: readonly SqlTransitionOwner[];
  sqlSeedAdapterFunctions: readonly string[];
};

const CANONICAL_SESSION_API =
  "Use processPipelineJob()/handleRejection() or the approve_session_stage transactional RPC.";
const CANONICAL_JOB_API =
  "Use claim_next_agent_job/schedule_job_retry or the processor job-result transition helpers.";
const CANONICAL_RUN_API =
  "Use the processor run lifecycle helpers or cancelSessionWork()/sweepStalledRuns().";

function transition(
  functionName: string,
  table: ProtectedTable,
  operation: MutationOperation,
  fields: readonly string[],
  requiredPredicates: readonly (readonly PredicateRequirement[])[] = [],
): TransitionPermission {
  return { fields, functionName, operation, requiredPredicates, table };
}

function sqlTransition(
  table: ProtectedTable,
  operation: MutationOperation,
  fields: readonly string[],
  requiredPredicates: readonly SqlPredicateRequirement[] = [],
): SqlTransitionPermission {
  return { fields, operation, requiredPredicates, table };
}

function predicate(
  field: string,
  method: PredicateMethod,
  value: PredicateValue,
  operator?: string,
): PredicateRequirement {
  return { field, method, ...(operator ? { operator } : {}), value };
}

function predicates(
  ...requirements: readonly PredicateRequirement[]
): readonly (readonly PredicateRequirement[])[] {
  return [requirements];
}

function predicateAlternatives(
  ...alternatives: readonly (readonly PredicateRequirement[])[]
): readonly (readonly PredicateRequirement[])[] {
  return alternatives;
}

function expression(value: string): PredicateValue {
  return { expression: value };
}

function sqlPredicate(
  field: string,
  operator: SqlPredicateRequirement["operator"],
  value: PredicateValue,
): SqlPredicateRequirement {
  return { field, operator, value };
}

export const PIPELINE_TRANSITION_CONTRACT: PipelineTransitionContract = {
  protectedFields: {
    agent_jobs: [
      "attempt_count",
      "dedupe_key",
      "finished_at",
      "scheduled_at",
      "started_at",
      "status",
    ],
    agent_runs: [
      "finished_at",
      "last_activity_at",
      "sandbox_connection_revision",
      "sandbox_id",
      "sandbox_provider",
      "sandbox_vercel_project_id",
      "sandbox_vercel_team_id",
      "started_at",
      "status",
    ],
    sessions: [
      "archived_at",
      "current_artifact_version",
      "current_stage_id",
      "pipeline_id",
      "phase_status",
      "rejection_count",
    ],
  },
  ordinaryOwners: [
    {
      canonicalApi: CANONICAL_SESSION_API,
      id: "pipeline-session-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition(
          "processPipelineJob",
          "sessions",
          "update",
          ["phase_status"],
          predicates(
            predicate("archived_at", "is", null),
            predicate("phase_status", "in", ["agent_generating", "awaiting_review", "rejected"]),
          ),
        ),
        transition(
          "runStage",
          "sessions",
          "update",
          ["current_artifact_version", "phase_status"],
          predicates(
            predicate("archived_at", "is", null),
            predicate("phase_status", "eq", "agent_generating"),
          ),
        ),
        transition(
          "handleRejection",
          "sessions",
          "update",
          ["rejection_count"],
          predicates(
            predicate("archived_at", "is", null),
            predicate("current_artifact_version", "eq", expression("input.version")),
            predicate("phase_status", "eq", "awaiting_review"),
            predicate("rejection_count", "eq", expression("session.rejection_count")),
          ),
        ),
        transition(
          "handleRejection",
          "sessions",
          "update",
          ["phase_status"],
          predicates(
            predicate("archived_at", "is", null),
            predicate("current_artifact_version", "eq", expression("input.version")),
            predicate("phase_status", "eq", "awaiting_review"),
            predicate("rejection_count", "eq", expression("session.rejection_count + 1")),
          ),
        ),
        transition(
          "updateSessionStatus",
          "sessions",
          "update",
          ["phase_status"],
          predicates(predicate("phase_status", "eq", "agent_generating")),
        ),
        transition(
          "updateSessionStatusAfterStageFailure",
          "sessions",
          "update",
          ["current_artifact_version", "phase_status"],
          predicates(predicate("phase_status", "eq", "awaiting_review")),
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      id: "pipeline-job-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition(
          "cleanupQueuedJob",
          "agent_jobs",
          "delete",
          [],
          predicates(predicate("status", "eq", "queued")),
        ),
        transition("enqueueSessionJobWithRun", "agent_jobs", "insert", ["dedupe_key"]),
        transition(
          "markPipelineJobSuccess",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "neq", "canceled")),
        ),
        transition(
          "markPipelineJobError",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "neq", "canceled")),
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      id: "pipeline-run-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition("enqueueSessionJobWithRun", "agent_runs", "insert", []),
        transition(
          "startAgentRun",
          "agent_runs",
          "update",
          ["started_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition("startAgentRun", "agent_runs", "insert", ["started_at", "status"]),
        transition(
          "updateRunSandbox",
          "agent_runs",
          "update",
          [
            "sandbox_connection_revision",
            "sandbox_id",
            "sandbox_provider",
            "sandbox_vercel_project_id",
            "sandbox_vercel_team_id",
          ],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "markRunSuccess",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "markRunError",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "touchRunActivity",
          "agent_runs",
          "update",
          ["last_activity_at"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
      ],
    },
    {
      canonicalApi: "Use archiveSession()/unarchiveSession().",
      id: "session-archive-transitions",
      path: "src/lib/pipeline/archive.ts",
      transitions: [
        transition(
          "archiveSession",
          "sessions",
          "update",
          ["archived_at"],
          predicates(predicate("archived_at", "is", null)),
        ),
        transition(
          "unarchiveSession",
          "sessions",
          "update",
          ["archived_at"],
          predicateAlternatives(
            [predicate("archived_at", "eq", expression("input.expectedArchivedAt"))],
            [predicate("archived_at", "not", null, "is")],
          ),
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      id: "wallie-job-transitions",
      path: "src/lib/wallie/service.ts",
      transitions: [
        transition(
          "claimJobIfQueued",
          "agent_jobs",
          "update",
          ["attempt_count", "started_at", "status"],
          predicates(predicate("status", "eq", "queued")),
        ),
        transition(
          "cleanupQueuedJob",
          "agent_jobs",
          "delete",
          [],
          predicates(predicate("status", "eq", "queued")),
        ),
        transition("createQueuedRun", "agent_jobs", "insert", ["dedupe_key"]),
      ],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      id: "wallie-run-transitions",
      path: "src/lib/wallie/service.ts",
      transitions: [transition("createQueuedRun", "agent_runs", "insert", [])],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      id: "worker-job-result-transition",
      path: "src/worker/loop.ts",
      transitions: [
        transition(
          "markJobError",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "neq", "canceled")),
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      id: "worker-run-activity-transition",
      path: "src/worker/loop.ts",
      transitions: [
        transition(
          "runClaimedJob",
          "agent_runs",
          "update",
          ["last_activity_at"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
      ],
    },
  ],
  recoveryOwners: [
    {
      canonicalApi: "Use cancelSessionWork()/cancelWorkspaceWork().",
      category: "cancellation",
      id: "cancellation-transitions",
      path: "src/lib/pipeline/cancel.ts",
      transitions: [
        transition(
          "cancelSessionWork",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "cancelSessionWork",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "cancelSessionWork",
          "sessions",
          "update",
          ["phase_status"],
          predicates(predicate("phase_status", "eq", "agent_generating")),
        ),
        transition(
          "cancelWorkspaceWork",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "cancelWorkspaceWork",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
      ],
    },
    {
      canonicalApi: "Use reconcileLinearState() and its owned routing helpers.",
      category: "reconciler",
      id: "linear-reconciler-transitions",
      path: "src/worker/reconciler.ts",
      transitions: [
        transition(
          "archiveSessionForLinearRoute",
          "sessions",
          "update",
          ["archived_at", "phase_status"],
          predicates(
            predicate("phase_status", "in", ["agent_generating", "awaiting_review", "rejected"]),
          ),
        ),
        transition(
          "routeSessionToStage",
          "sessions",
          "update",
          [
            "archived_at",
            "current_artifact_version",
            "current_stage_id",
            "phase_status",
            "rejection_count",
          ],
          predicates(
            predicate("phase_status", "in", ["agent_generating", "awaiting_review", "rejected"]),
          ),
        ),
        transition("ensurePipelineJobQueued", "agent_jobs", "insert", ["dedupe_key"]),
      ],
    },
    {
      canonicalApi: "Use sweepStalledRuns() and resolveStalledJob().",
      category: "stall-detector",
      id: "stall-detector-transitions",
      path: "src/worker/stall-detector.ts",
      transitions: [
        transition(
          "sweepStalledRuns",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "sweepStalledRuns",
          "sessions",
          "update",
          ["phase_status"],
          predicates(predicate("phase_status", "eq", "agent_generating")),
        ),
        transition(
          "resolveStalledJob",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "eq", "running")),
        ),
      ],
    },
    {
      canonicalApi: "Use the processor's guarded cleanup helpers.",
      category: "repair",
      id: "processor-repair-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition(
          "cancelQueuedRunsForJob",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
        transition(
          "markActiveRunsForJobError",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          predicates(predicate("status", "in", ["queued", "started", "running"])),
        ),
      ],
    },
    {
      canonicalApi: "Use the workspace-delete compensating parkGeneratingSessions() helper.",
      category: "repair",
      id: "workspace-delete-repair-transition",
      path: "src/app/api/workspaces/[workspaceId]/route.ts",
      transitions: [
        transition(
          "parkGeneratingSessions",
          "sessions",
          "update",
          ["phase_status"],
          predicates(predicate("phase_status", "eq", "agent_generating")),
        ),
      ],
    },
    {
      canonicalApi: "Use runMaintenanceTick() to compose named recovery owners.",
      category: "repair",
      id: "manual-repair-orchestrator",
      path: "src/lib/maintenance/service.ts",
      requiredFunctions: ["runMaintenanceTick"],
      requiredMarkers: ["sweepStalledRuns(", "reapOrphanSandboxes(", "reconcileLinearState("],
      transitions: [],
    },
    {
      canonicalApi: "Use reapOrphanSandboxes() for provider cleanup.",
      category: "reaper",
      id: "sandbox-reaper",
      path: "src/worker/sandbox-reaper.ts",
      requiredFunctions: ["reapOrphanSandboxes"],
      requiredMarkers: ['.from("agent_runs")', '.from("agent_jobs")', "status"],
      transitions: [],
    },
  ],
  sqlOwners: [
    {
      canonicalApi: "Use the approve_session_stage transactional RPC.",
      functionName: "public.approve_session_stage",
      id: "stage-approval-rpc",
      signature: "public.approve_session_stage(uuid,uuid,integer,uuid)",
      transitions: [
        sqlTransition(
          "sessions",
          "update",
          ["phase_status"],
          [
            sqlPredicate("id", "=", expression("target_session_id")),
            sqlPredicate("workspace_id", "=", expression("expected_workspace_id")),
            sqlPredicate("current_artifact_version", "=", expression("expected_version")),
            sqlPredicate("phase_status", "=", "awaiting_review"),
            sqlPredicate("archived_at", "is", null),
          ],
        ),
        sqlTransition(
          "sessions",
          "update",
          ["archived_at"],
          [sqlPredicate("id", "=", expression("target_session_id"))],
        ),
        sqlTransition(
          "sessions",
          "update",
          ["current_artifact_version", "current_stage_id", "phase_status", "rejection_count"],
          [sqlPredicate("id", "=", expression("target_session_id"))],
        ),
      ],
    },
    {
      canonicalApi: "Use the claim_agent_job transactional RPC.",
      functionName: "public.claim_agent_job",
      id: "legacy-job-claim-rpc",
      signature: "public.claim_agent_job(uuid,int)",
      transitions: [
        sqlTransition(
          "agent_jobs",
          "update",
          ["attempt_count", "scheduled_at", "started_at", "status"],
          [
            sqlPredicate("id", "=", expression("target_job_id")),
            sqlPredicate("status", "=", "queued"),
          ],
        ),
      ],
    },
    {
      canonicalApi: "Use the claim_next_agent_job transactional RPC.",
      functionName: "public.claim_next_agent_job",
      id: "worker-job-claim-rpc",
      signature: "public.claim_next_agent_job(int)",
      transitions: [
        sqlTransition(
          "agent_jobs",
          "update",
          ["attempt_count", "scheduled_at", "started_at", "status"],
          [
            sqlPredicate("id", "=", expression("candidate.id")),
            sqlPredicate("status", "=", "queued"),
          ],
        ),
      ],
    },
    {
      canonicalApi: "Use the schedule_job_retry transactional RPC.",
      functionName: "public.schedule_job_retry",
      id: "job-retry-rpc",
      signature: "public.schedule_job_retry(uuid,int,int)",
      transitions: [
        sqlTransition(
          "agent_jobs",
          "update",
          ["finished_at", "scheduled_at", "status"],
          [
            sqlPredicate("id", "=", expression("target_job_id")),
            sqlPredicate("status", "<>", "canceled"),
          ],
        ),
      ],
    },
    {
      canonicalApi: "Use the create_session_with_first_job transactional RPC.",
      functionName: "public.create_session_with_first_job",
      id: "session-create-rpc",
      signature:
        "public.create_session_with_first_job(uuid,uuid,text,text,text,text,text,text,uuid,uuid)",
      transitions: [
        sqlTransition("sessions", "insert", ["current_stage_id", "phase_status", "pipeline_id"]),
        sqlTransition("agent_jobs", "insert", ["dedupe_key", "status"]),
        sqlTransition("agent_runs", "insert", ["status"]),
      ],
    },
  ],
  sqlMigrationOwners: [
    {
      canonicalApi:
        "Keep sandbox routing backfills in the provider migration; use updateRunSandbox() at runtime.",
      id: "sandbox-provider-routing-backfill",
      path: "supabase/migrations/20260721000001_add_e2b_daytona_sandbox_providers.sql",
      transitions: [
        sqlTransition(
          "agent_runs",
          "update",
          ["sandbox_connection_revision"],
          [
            sqlPredicate("sandbox_provider", "=", "vercel"),
            sqlPredicate("sandbox_vercel_team_id", "=", expression("connection.team_id")),
            sqlPredicate("sandbox_vercel_project_id", "=", expression("connection.project_id")),
            sqlPredicate("sandbox_connection_revision", "is", null),
          ],
        ),
      ],
    },
  ],
  seededStageSlugs: ["build", "land", "plan"],
  defaultAdapterPaths: [
    "src/app/dev/",
    "src/lib/linear-routing/contracts.ts",
    "src/lib/pipeline/defaults.ts",
  ],
  sqlSeedAdapterFunctions: [
    "internal.default_pipeline_stages",
    "public.rewrite_default_pipeline",
    "public.rewrite_default_pipeline_with_approval_policy",
  ],
};

const MUTATION_OPERATIONS = new Set<MutationOperation>(["delete", "insert", "update", "upsert"]);
const PREDICATE_METHODS = new Set(["eq", "in", "is", "neq", "not"]);

type Initializer = {
  expression: ts.Expression;
  position: number;
  scope: ts.Node;
};

type BindingSource = Initializer & {
  propertyName: string | null;
};

type SourceContext = {
  bindingSources: Map<string, BindingSource[]>;
  declaredNames: Map<ts.Node, Set<string>>;
  initializers: Map<string, Initializer[]>;
  objectFactories: Map<string, ts.Expression>;
  sourceFile: ts.SourceFile;
};

type Mutation = {
  call: ts.CallExpression;
  fields: Set<string>;
  fieldsKnown: boolean;
  functionName: string | null;
  operation: MutationOperation;
  table: ProtectedTable;
};

export function loadPipelineContractFiles(rootDirectory = process.cwd()): PipelineContractFile[] {
  return [
    ...loadDirectory(rootDirectory, "src", new Set([".ts", ".tsx"])),
    ...loadDirectory(rootDirectory, "supabase/migrations", new Set([".sql"])),
  ].filter(
    (file) =>
      !file.path.includes("/__fixtures__/") &&
      !file.path.endsWith(".d.ts") &&
      !file.path.includes(".test.") &&
      !file.path.includes(".spec."),
  );
}

export function verifyPipelineContract(
  files: readonly PipelineContractFile[],
  contract: PipelineTransitionContract = PIPELINE_TRANSITION_CONTRACT,
): PipelineContractDiagnostic[] {
  const diagnostics: PipelineContractDiagnostic[] = [];
  const usedRecoveryTransitions = new Set<string>();
  const usedSqlMigrationTransitions = new Set<string>();
  const latestSqlDefinitions = findLatestSqlDefinitions(files, contract);

  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    if (normalizedPath.endsWith(".sql")) {
      diagnostics.push(
        ...verifySqlFile(
          { ...file, path: normalizedPath },
          contract,
          latestSqlDefinitions,
          usedSqlMigrationTransitions,
        ),
      );
      continue;
    }
    if (!normalizedPath.endsWith(".ts") && !normalizedPath.endsWith(".tsx")) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      normalizedPath,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      normalizedPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const context: SourceContext = {
      bindingSources: collectBindingSources(sourceFile),
      declaredNames: collectDeclaredNames(sourceFile),
      initializers: collectInitializers(sourceFile),
      objectFactories: collectObjectFactories(sourceFile),
      sourceFile,
    };

    walk(sourceFile, (node) => {
      if (ts.isCallExpression(node)) {
        const mutation = readMutation(node, context);
        if (mutation) {
          const protectedFields = readProtectedMutationFields(mutation, contract);
          const writesProtectedState =
            mutation.operation === "delete" ||
            mutation.operation === "insert" ||
            mutation.operation === "upsert" ||
            protectedFields === null ||
            protectedFields.length > 0;
          if (writesProtectedState) {
            const recoveryOwner = findDeclaringOwner(
              contract.recoveryOwners,
              normalizedPath,
              mutation,
            );
            const ordinaryOwner = findDeclaringOwner(
              contract.ordinaryOwners,
              normalizedPath,
              mutation,
            );
            const owner = recoveryOwner ?? ordinaryOwner;

            if (!owner) {
              diagnostics.push(
                diagnostic(
                  context.sourceFile,
                  mutation.call,
                  "pipeline-owner",
                  `Direct ${mutation.table} ${mutation.operation} is not owned by a named transition API. ${canonicalApiForTable(
                    mutation.table,
                  )}`,
                ),
              );
            } else {
              const permission = findTransitionPermission(owner, mutation, protectedFields);
              if (!permission) {
                const fieldDescription =
                  protectedFields === null
                    ? "an unresolved payload"
                    : protectedFields.length > 0
                      ? `protected fields ${protectedFields.join(", ")}`
                      : "the protected row lifecycle";
                diagnostics.push(
                  diagnostic(
                    context.sourceFile,
                    mutation.call,
                    "pipeline-owner",
                    `${owner.id} does not permit ${mutation.functionName ?? "this function"} to ${mutation.operation} ${mutation.table} with ${fieldDescription}. ${owner.canonicalApi}`,
                  ),
                );
                return;
              }
              if (recoveryOwner) {
                usedRecoveryTransitions.add(
                  recoveryTransitionUsageKey(recoveryOwner.id, permission.index),
                );
              }
              const missingPredicates = findMissingPredicates(
                mutation,
                context,
                permission.transition.requiredPredicates,
              );
              if (missingPredicates.length > 0) {
                diagnostics.push(
                  diagnostic(
                    context.sourceFile,
                    mutation.call,
                    "pipeline-cas",
                    `${owner.id} writes protected ${mutation.table} state without required expected-state predicate${
                      missingPredicates.length === 1 ? "" : "s"
                    }: ${missingPredicates.join(", ")}. ${owner.canonicalApi}`,
                  ),
                );
              }
            }
          }
        }
      }

      if (
        !isDefaultAdapterPath(normalizedPath, contract.defaultAdapterPaths) &&
        isSeededStageBranch(node, context, contract.seededStageSlugs)
      ) {
        diagnostics.push(
          diagnostic(
            context.sourceFile,
            node,
            "seeded-stage-branch",
            "Generic pipeline production code cannot branch on a seeded stage slug. Resolve stages by pipeline stage id/position; seeded defaults belong in a designated default adapter.",
          ),
        );
      }
    });
  }

  for (const recoveryOwner of contract.recoveryOwners) {
    const file = files.find((candidate) => normalizePath(candidate.path) === recoveryOwner.path);
    for (const [index, permission] of recoveryOwner.transitions.entries()) {
      if (!usedRecoveryTransitions.has(recoveryTransitionUsageKey(recoveryOwner.id, index))) {
        diagnostics.push({
          code: "recovery-owner-unused",
          line: 1,
          message: `${recoveryOwner.category} exception ${recoveryOwner.id} declares ${formatTransitionPermission(
            permission,
          )} but no matching owned path uses it. Remove the stale exception or restore the canonical recovery path.`,
          path: recoveryOwner.path,
        });
      }
    }
    for (const functionName of recoveryOwner.requiredFunctions ?? []) {
      if (!file || !sourceDeclaresFunction(file.source, functionName)) {
        diagnostics.push({
          code: "recovery-owner-unused",
          line: 1,
          message: `${recoveryOwner.category} exception ${recoveryOwner.id} requires ${functionName}, but no matching owned path declares it. Remove the stale exception or restore the canonical recovery path.`,
          path: recoveryOwner.path,
        });
      }
    }
    for (const marker of recoveryOwner.requiredMarkers ?? []) {
      if (!file?.source.includes(marker)) {
        diagnostics.push({
          code: "recovery-owner-unused",
          line: 1,
          message: `${recoveryOwner.category} exception ${recoveryOwner.id} requires marker ${JSON.stringify(
            marker,
          )}, but it is unused. Remove the stale exception or restore the canonical recovery path.`,
          path: recoveryOwner.path,
        });
      }
    }
  }

  for (const owner of contract.sqlMigrationOwners) {
    for (const [index, permission] of owner.transitions.entries()) {
      if (usedSqlMigrationTransitions.has(sqlMigrationTransitionUsageKey(owner.id, index))) {
        continue;
      }
      diagnostics.push({
        code: "recovery-owner-unused",
        line: 1,
        message: `migration exception ${owner.id} declares ${formatSqlTransitionPermission(
          permission,
        )} but no matching owned path uses it. Remove the stale exception or restore the canonical migration path.`,
        path: owner.path,
      });
    }
  }

  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
}

type SqlDefinitionLocation = {
  path: string;
  start: number;
};

function findLatestSqlDefinitions(
  files: readonly PipelineContractFile[],
  contract: PipelineTransitionContract,
): ReadonlyMap<string, SqlDefinitionLocation> {
  const ownerSignatures = new Set(contract.sqlOwners.map((owner) => owner.signature));
  const latestDefinitions = new Map<string, SqlDefinitionLocation>();
  const sqlFiles = files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => file.path.endsWith(".sql"))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const file of sqlFiles) {
    for (const sqlFunction of readSqlFunctions(maskSqlComments(file.source))) {
      if (ownerSignatures.has(sqlFunction.signature)) {
        latestDefinitions.set(sqlFunction.signature, {
          path: file.path,
          start: sqlFunction.start,
        });
      }
    }
  }
  return latestDefinitions;
}

export function formatPipelineContractDiagnostics(
  diagnostics: readonly PipelineContractDiagnostic[],
): string {
  return diagnostics
    .map((item) => `${item.path}:${item.line} [${item.code}] ${item.message}`)
    .join("\n");
}

function loadDirectory(
  rootDirectory: string,
  relativeDirectory: string,
  extensions: ReadonlySet<string>,
): PipelineContractFile[] {
  const absoluteDirectory = resolve(rootDirectory, relativeDirectory);
  const files: PipelineContractFile[] = [];

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = resolve(absoluteDirectory, entry.name);
    const relativePath = normalizePath(relative(rootDirectory, absolutePath));
    if (entry.isDirectory()) {
      files.push(...loadDirectory(rootDirectory, relativePath, extensions));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (extensions.has(extension)) {
      files.push({ path: relativePath, source: readFileSync(absolutePath, "utf8") });
    }
  }

  return files;
}

function collectInitializers(sourceFile: ts.SourceFile): Map<string, Initializer[]> {
  const initializers = new Map<string, Initializer[]>();
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = initializers.get(node.name.text) ?? [];
      entries.push({
        expression: node.initializer,
        position: node.getStart(sourceFile),
        scope: variableDeclarationScope(node),
      });
      initializers.set(node.name.text, entries);
    }
  });
  return initializers;
}

function collectDeclaredNames(sourceFile: ts.SourceFile): Map<ts.Node, Set<string>> {
  const declarations = new Map<ts.Node, Set<string>>();
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) {
      addBindingNames(declarations, variableDeclarationScope(node), node.name);
    } else if (ts.isParameter(node)) {
      const scope = enclosingFunction(node);
      if (scope) {
        addBindingNames(declarations, scope, node.name);
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingNames(declarations, node, node.variableDeclaration.name);
    }
  });
  return declarations;
}

function addBindingNames(
  declarations: Map<ts.Node, Set<string>>,
  scope: ts.Node,
  name: ts.BindingName,
): void {
  const names = declarations.get(scope) ?? new Set<string>();
  const collect = (bindingName: ts.BindingName): void => {
    if (ts.isIdentifier(bindingName)) {
      names.add(bindingName.text);
      return;
    }
    for (const element of bindingName.elements) {
      if (!ts.isOmittedExpression(element)) {
        collect(element.name);
      }
    }
  };
  collect(name);
  declarations.set(scope, names);
}

function collectObjectFactories(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const factories = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) {
      continue;
    }
    let returnedExpression: ts.Expression | null = null;
    let returnCount = 0;
    const visit = (node: ts.Node): void => {
      if (node !== statement.body && ts.isFunctionLike(node)) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression) {
        returnCount += 1;
        returnedExpression = node.expression;
        return;
      }
      node.forEachChild(visit);
    };
    visit(statement.body);
    if (returnCount === 1 && returnedExpression) {
      factories.set(statement.name.text, returnedExpression);
    }
  }
  return factories;
}

function collectBindingSources(sourceFile: ts.SourceFile): Map<string, BindingSource[]> {
  const bindingSources = new Map<string, BindingSource[]>();
  walk(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const entries = bindingSources.get(element.name.text) ?? [];
      entries.push({
        expression: node.initializer,
        position: node.getStart(sourceFile),
        propertyName: element.propertyName ? propertyName(element.propertyName) : element.name.text,
        scope: variableDeclarationScope(node),
      });
      bindingSources.set(element.name.text, entries);
    }
  });
  return bindingSources;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function readMutation(call: ts.CallExpression, context: SourceContext): Mutation | null {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const operation = call.expression.name.text as MutationOperation;
  if (!MUTATION_OPERATIONS.has(operation)) {
    return null;
  }

  const table = findTable(call.expression.expression, call.getStart(), context);
  if (!table) {
    return null;
  }

  const payload = readObjectFields(call.arguments[0], call.getStart(), context);
  return {
    call,
    fields: payload.fields,
    fieldsKnown: operation === "delete" || payload.known,
    functionName: enclosingFunctionName(call),
    operation,
    table,
  };
}

function findTable(
  expression: ts.Expression,
  position: number,
  context: SourceContext,
  seen = new Set<string>(),
): ProtectedTable | null {
  const resolved = resolveExpression(expression, position, context, seen);
  if (ts.isCallExpression(resolved) && ts.isPropertyAccessExpression(resolved.expression)) {
    if (resolved.expression.name.text === "from") {
      const tableName = readString(resolved.arguments[0], position, context);
      return isProtectedTable(tableName) ? tableName : null;
    }
    return findTable(resolved.expression.expression, position, context, seen);
  }
  return null;
}

function resolveExpression(
  expression: ts.Expression,
  position: number,
  context: SourceContext,
  seen = new Set<string>(),
): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return resolveExpression(expression.expression, position, context, seen);
  }
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    seen.add(expression.text);
    const initializer = nearestInitializer(
      context.initializers.get(expression.text),
      position,
      expression,
      context,
      expression.text,
    );
    if (initializer) {
      return resolveExpression(initializer.expression, position, context, seen);
    }
  }
  return expression;
}

function nearestInitializer(
  initializers: readonly Initializer[] | undefined,
  position: number,
  useNode: ts.Node,
  context: SourceContext,
  name: string,
): Initializer | null {
  return nearestScopedEntry(initializers, position, useNode, context, name);
}

function nearestBindingSource(
  sources: readonly BindingSource[] | undefined,
  position: number,
  useNode: ts.Node,
  context: SourceContext,
  name: string,
): BindingSource | null {
  return nearestScopedEntry(sources, position, useNode, context, name);
}

function nearestScopedEntry<T extends Initializer>(
  entries: readonly T[] | undefined,
  position: number,
  useNode: ts.Node,
  context: SourceContext,
  name: string,
): T | null {
  for (const scope of lexicalScopeChain(useNode)) {
    const candidate =
      entries
        ?.filter((entry) => entry.scope === scope && entry.position < position)
        .sort((left, right) => right.position - left.position)[0] ?? null;
    if (candidate) {
      return candidate;
    }
    if (context.declaredNames.get(scope)?.has(name)) {
      return null;
    }
  }
  return null;
}

function variableDeclarationScope(declaration: ts.VariableDeclaration): ts.Node {
  const declarationList = declaration.parent;
  if (ts.isCatchClause(declarationList)) {
    return declarationList;
  }
  if (
    ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
  ) {
    return nearestBlockScope(declarationList);
  }
  return enclosingFunction(declaration) ?? declaration.getSourceFile();
}

function nearestBlockScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function lexicalScopeChain(node: ts.Node): ts.Node[] {
  const scopes: ts.Node[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionLike(current) ||
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isSourceFile(current)
    ) {
      scopes.push(current);
    }
    current = current.parent;
  }
  return scopes;
}

function readString(
  expression: ts.Expression | undefined,
  position: number,
  context: SourceContext,
): string | null {
  if (!expression) return null;
  const resolved = resolveExpression(expression, position, context);
  return ts.isStringLiteralLike(resolved) ? resolved.text : null;
}

function readObjectFields(
  expression: ts.Expression | undefined,
  position: number,
  context: SourceContext,
  seen = new Set<ts.Expression>(),
): { fields: Set<string>; known: boolean } {
  if (!expression) return { fields: new Set(), known: false };
  const resolved = resolveExpression(expression, position, context);
  if (seen.has(resolved)) {
    return { fields: new Set(), known: false };
  }
  seen.add(resolved);
  if (ts.isConditionalExpression(resolved)) {
    const whenTrue = readObjectFields(resolved.whenTrue, position, context, seen);
    const whenFalse = readObjectFields(resolved.whenFalse, position, context, seen);
    return {
      fields: new Set([...whenTrue.fields, ...whenFalse.fields]),
      known: whenTrue.known && whenFalse.known,
    };
  }
  if (ts.isCallExpression(resolved) && ts.isIdentifier(resolved.expression)) {
    const returnedExpression = context.objectFactories.get(resolved.expression.text);
    return returnedExpression
      ? readObjectFields(returnedExpression, position, context, seen)
      : { fields: new Set(), known: false };
  }
  if (!ts.isObjectLiteralExpression(resolved)) {
    return { fields: new Set(), known: false };
  }
  const fields = new Set<string>();
  let known = true;
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = readObjectFields(property.expression, position, context, seen);
      known &&= spread.known;
      for (const field of spread.fields) {
        fields.add(field);
      }
      continue;
    }
    const name = property.name && propertyName(property.name);
    if (name) {
      fields.add(name);
    } else {
      known = false;
    }
  }
  return { fields, known };
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (
      (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function findDeclaringOwner<T extends TransitionOwner>(
  owners: readonly T[],
  path: string,
  mutation: Mutation,
): T | null {
  return (
    owners.find(
      (owner) =>
        owner.path === path &&
        Boolean(
          mutation.functionName &&
          owner.transitions.some(
            (permission) =>
              permission.functionName === mutation.functionName &&
              permission.table === mutation.table,
          ),
        ),
    ) ?? null
  );
}

function readProtectedMutationFields(
  mutation: Mutation,
  contract: PipelineTransitionContract,
): string[] | null {
  if (!mutation.fieldsKnown) {
    return null;
  }
  const protectedFields = new Set(contract.protectedFields[mutation.table]);
  return [...mutation.fields].filter((field) => protectedFields.has(field)).sort();
}

function findTransitionPermission(
  owner: TransitionOwner,
  mutation: Mutation,
  protectedFields: readonly string[] | null,
): { index: number; transition: TransitionPermission } | null {
  if (protectedFields === null || !mutation.functionName) {
    return null;
  }
  const index = owner.transitions.findIndex(
    (permission) =>
      permission.functionName === mutation.functionName &&
      permission.table === mutation.table &&
      permission.operation === mutation.operation &&
      sameFields(permission.fields, protectedFields),
  );
  return index < 0 ? null : { index, transition: owner.transitions[index]! };
}

function findMissingPredicates(
  mutation: Mutation,
  context: SourceContext,
  requiredPredicateAlternatives: readonly (readonly PredicateRequirement[])[],
): string[] {
  if (requiredPredicateAlternatives.length === 0) {
    return [];
  }
  const observedPredicates: ObservedPredicate[] = [];
  collectOuterPredicates(mutation.call, mutation.call.getStart(), context, observedPredicates);
  const missingAlternatives = requiredPredicateAlternatives.map((requirements) =>
    requirements.filter(
      (requirement) =>
        !observedPredicates.some((observed) => predicatesMatch(requirement, observed)),
    ),
  );
  if (missingAlternatives.some((missing) => missing.length === 0)) {
    return [];
  }
  const closest = [...missingAlternatives].sort((left, right) => left.length - right.length)[0]!;
  return closest.map(formatPredicateRequirement);
}

type ObservedPredicate = {
  field: string;
  method: PredicateMethod;
  operator?: string;
  value: string;
};

function predicatesMatch(requirement: PredicateRequirement, observed: ObservedPredicate): boolean {
  return (
    requirement.field === observed.field &&
    requirement.method === observed.method &&
    requirement.operator === observed.operator &&
    canonicalExpectedPredicateValue(requirement.value) === observed.value
  );
}

function collectOuterPredicates(
  mutationCall: ts.CallExpression,
  position: number,
  context: SourceContext,
  predicates: ObservedPredicate[],
): void {
  let expression: ts.Expression = mutationCall;
  while (
    expression.parent &&
    ts.isPropertyAccessExpression(expression.parent) &&
    expression.parent.expression === expression &&
    expression.parent.parent &&
    ts.isCallExpression(expression.parent.parent)
  ) {
    const outerCall = expression.parent.parent;
    const method = expression.parent.name.text;
    if (PREDICATE_METHODS.has(method)) {
      const field = readString(outerCall.arguments[0], position, context);
      const predicateMethod = method as PredicateMethod;
      const operator =
        predicateMethod === "not"
          ? (readString(outerCall.arguments[1], position, context) ?? undefined)
          : undefined;
      const valueExpression =
        predicateMethod === "not" ? outerCall.arguments[2] : outerCall.arguments[1];
      if (field && valueExpression) {
        predicates.push({
          field,
          method: predicateMethod,
          ...(operator ? { operator } : {}),
          value: canonicalObservedPredicateValue(valueExpression, position, context),
        });
      }
    }
    expression = outerCall;
  }
}

function canonicalObservedPredicateValue(
  value: ts.Expression,
  position: number,
  context: SourceContext,
): string {
  const resolved = resolveExpression(value, position, context);
  if (ts.isStringLiteralLike(resolved)) return canonicalScalar(resolved.text);
  if (ts.isNumericLiteral(resolved)) return canonicalScalar(Number(resolved.text));
  if (resolved.kind === ts.SyntaxKind.NullKeyword) return canonicalScalar(null);
  if (resolved.kind === ts.SyntaxKind.TrueKeyword) return canonicalScalar(true);
  if (resolved.kind === ts.SyntaxKind.FalseKeyword) return canonicalScalar(false);
  if (ts.isArrayLiteralExpression(resolved)) {
    const values = resolved.elements.map((element) =>
      canonicalObservedPredicateValue(element as ts.Expression, position, context),
    );
    return `array:${JSON.stringify(values)}`;
  }
  return `expression:${normalizeExpressionText(resolved.getText(context.sourceFile))}`;
}

function canonicalExpectedPredicateValue(value: PredicateValue): string {
  if (Array.isArray(value)) {
    return `array:${JSON.stringify(value.map(canonicalScalar))}`;
  }
  if (typeof value === "object" && value !== null && "expression" in value) {
    return `expression:${normalizeExpressionText(value.expression)}`;
  }
  return canonicalScalar(value as PredicateScalar);
}

function canonicalScalar(value: PredicateScalar): string {
  return `scalar:${JSON.stringify(value)}`;
}

function normalizeExpressionText(value: string): string {
  return value.replace(/\s+/g, "");
}

function formatPredicateRequirement(requirement: PredicateRequirement): string {
  const operator = requirement.operator ? ` ${requirement.operator}` : "";
  const value =
    typeof requirement.value === "object" &&
    requirement.value !== null &&
    !Array.isArray(requirement.value) &&
    "expression" in requirement.value
      ? requirement.value.expression
      : JSON.stringify(requirement.value);
  return `${requirement.field} ${requirement.method}${operator} ${value}`;
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((field, index) => field === sortedRight[index]);
}

function formatTransitionPermission(permission: TransitionPermission): string {
  const fields =
    permission.fields.length > 0 ? ` fields ${permission.fields.join(", ")}` : " row lifecycle";
  return `${permission.functionName} ${permission.operation} ${permission.table}${fields}`;
}

function formatSqlTransitionPermission(permission: SqlTransitionPermission): string {
  const fields =
    permission.fields.length > 0 ? ` fields ${permission.fields.join(", ")}` : " row lifecycle";
  return `${permission.operation} ${permission.table}${fields}`;
}

function isSeededStageBranch(
  node: ts.Node,
  context: SourceContext,
  seededSlugs: readonly string[],
): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === "includes" || node.expression.name.text === "has") &&
    node.arguments[0] &&
    isStageSlugExpression(node.arguments[0], node.getStart(), context) &&
    isSeededSlugCollection(node.expression.expression, node.getStart(), context, seededSlugs)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind)) {
    return (
      (isStageSlugExpression(node.left, node.getStart(), context) &&
        isSeededSlugExpression(node.right, node.getStart(), context, seededSlugs)) ||
      (isStageSlugExpression(node.right, node.getStart(), context) &&
        isSeededSlugExpression(node.left, node.getStart(), context, seededSlugs))
    );
  }
  if (ts.isCaseClause(node) && node.parent.parent) {
    const switchStatement = node.parent.parent;
    return (
      ts.isSwitchStatement(switchStatement) &&
      isStageSlugExpression(switchStatement.expression, node.getStart(), context) &&
      isSeededSlugExpression(node.expression, node.getStart(), context, seededSlugs)
    );
  }
  return false;
}

function isSeededSlugCollection(
  expressionNode: ts.Expression,
  position: number,
  context: SourceContext,
  seededSlugs: readonly string[],
): boolean {
  const resolved = resolveExpression(expressionNode, position, context);
  if (ts.isArrayLiteralExpression(resolved)) {
    return resolved.elements.some((element) =>
      isSeededSlugExpression(element as ts.Expression, position, context, seededSlugs),
    );
  }
  return Boolean(
    ts.isNewExpression(resolved) &&
    ts.isIdentifier(resolved.expression) &&
    resolved.expression.text === "Set" &&
    resolved.arguments?.[0] &&
    isSeededSlugCollection(resolved.arguments[0], position, context, seededSlugs),
  );
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(kind);
}

function isStageSlugExpression(
  expression: ts.Expression,
  position: number,
  context: SourceContext,
  seen = new Set<string>(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "slug") {
    return isStageExpression(unwrapped.expression, position, context, seen);
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    readString(unwrapped.argumentExpression, position, context) === "slug"
  ) {
    return isStageExpression(unwrapped.expression, position, context, seen);
  }
  if (!ts.isIdentifier(unwrapped)) {
    return false;
  }

  const name = unwrapped.text;
  if (/\bstage[\w$]*slug\b|\bslug[\w$]*stage\b/i.test(name)) {
    return true;
  }
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);

  const initializer = nearestInitializer(
    context.initializers.get(name),
    position,
    unwrapped,
    context,
    name,
  );
  if (initializer) {
    return isStageSlugExpression(initializer.expression, position, context, seen);
  }

  const binding = nearestBindingSource(
    context.bindingSources.get(name),
    position,
    unwrapped,
    context,
    name,
  );
  return Boolean(
    binding &&
    binding.propertyName === "slug" &&
    isStageExpression(binding.expression, position, context, seen),
  );
}

function isStageExpression(
  expression: ts.Expression,
  position: number,
  context: SourceContext,
  seen: Set<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    if (seen.has(unwrapped.text)) {
      return /\bstage\b/i.test(unwrapped.text);
    }
    seen.add(unwrapped.text);
    const initializer = nearestInitializer(
      context.initializers.get(unwrapped.text),
      position,
      unwrapped,
      context,
      unwrapped.text,
    );
    if (initializer) {
      return isStageExpression(initializer.expression, position, context, seen);
    }
    return /stage/i.test(unwrapped.text) && !/slug/i.test(unwrapped.text);
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return (
      /stage/i.test(unwrapped.name.text) ||
      isStageExpression(unwrapped.expression, position, context, seen)
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    return /stage/i.test(unwrapped.expression.getText(context.sourceFile));
  }
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isSeededSlugExpression(
  expression: ts.Expression,
  position: number,
  context: SourceContext,
  seededSlugs: readonly string[],
): boolean {
  const value = readString(expression, position, context);
  return Boolean(value && seededSlugs.includes(value));
}

function verifySqlFile(
  file: PipelineContractFile,
  contract: PipelineTransitionContract,
  latestSqlDefinitions: ReadonlyMap<string, SqlDefinitionLocation>,
  usedSqlMigrationTransitions: Set<string>,
): PipelineContractDiagnostic[] {
  const diagnostics: PipelineContractDiagnostic[] = [];
  const commentMaskedSource = maskSqlComments(file.source);
  const functionSpans = readSqlFunctions(commentMaskedSource);

  for (const sqlFunction of functionSpans) {
    const owner = contract.sqlOwners.find(
      (candidate) => candidate.signature === sqlFunction.signature,
    );
    const latestDefinition = latestSqlDefinitions.get(sqlFunction.signature);
    const enforceOwnerPredicates = Boolean(
      owner && latestDefinition?.path === file.path && latestDefinition.start === sqlFunction.start,
    );
    const mutations = [
      ...readSqlMutations(
        maskSqlStringLiterals(sqlFunction.body),
        sqlFunction.bodyStart,
        sqlFunction.body,
      ),
      ...readExecutedSqlMutations(sqlFunction.body, sqlFunction.bodyStart),
    ];
    for (const mutation of mutations) {
      const protectedFields = readProtectedSqlFields(mutation, contract);
      const writesProtectedState =
        mutation.operation === "delete" ||
        mutation.operation === "insert" ||
        protectedFields === null ||
        protectedFields.length > 0;
      if (!writesProtectedState) continue;
      const permission =
        protectedFields === null
          ? undefined
          : owner?.transitions.find(
              (candidate) =>
                candidate.table === mutation.table &&
                candidate.operation === mutation.operation &&
                sameFields(candidate.fields, protectedFields),
            );
      if (!permission) {
        const ownerMessage = owner
          ? `${owner.id} does not permit ${mutation.operation} ${mutation.table} fields ${
              protectedFields?.join(", ") || "(unresolved row lifecycle)"
            }. ${owner.canonicalApi}`
          : `SQL function ${sqlFunction.name} writes protected ${
              mutation.table
            } state without owning that transition. ${canonicalApiForTable(mutation.table)}`;
        diagnostics.push({
          code: "pipeline-owner",
          line: lineAt(file.source, mutation.position),
          message: ownerMessage,
          path: file.path,
        });
      } else if (enforceOwnerPredicates) {
        const missingPredicates = findMissingSqlPredicates(mutation, permission.requiredPredicates);
        if (missingPredicates.length > 0) {
          diagnostics.push({
            code: "pipeline-cas",
            line: lineAt(file.source, mutation.position),
            message: `${owner!.id} writes protected ${mutation.table} state without required SQL expected-state predicate${
              missingPredicates.length === 1 ? "" : "s"
            }: ${missingPredicates.join(", ")}. ${owner!.canonicalApi}`,
            path: file.path,
          });
        }
      }
    }

    if (
      !contract.sqlSeedAdapterFunctions.includes(sqlFunction.name) &&
      sqlBranchesOnSeededStage(sqlFunction.body, contract.seededStageSlugs)
    ) {
      diagnostics.push({
        code: "seeded-stage-branch",
        line: lineAt(file.source, sqlFunction.bodyStart),
        message: `SQL function ${sqlFunction.name} branches on a seeded stage slug. Resolve stages from pipeline_stages id/position; seeded defaults belong in a designated default adapter.`,
        path: file.path,
      });
    }
  }

  const maskedSource = maskSpans(commentMaskedSource, functionSpans);
  for (const mutation of readSqlMutations(maskSqlStringLiterals(maskedSource), 0, maskedSource)) {
    const protectedFields = readProtectedSqlFields(mutation, contract);
    const writesProtectedState =
      mutation.operation === "delete" ||
      mutation.operation === "insert" ||
      protectedFields === null ||
      protectedFields.length > 0;
    if (writesProtectedState) {
      const owner = contract.sqlMigrationOwners.find((candidate) => candidate.path === file.path);
      const permissionIndex =
        protectedFields === null
          ? -1
          : (owner?.transitions.findIndex(
              (candidate) =>
                candidate.table === mutation.table &&
                candidate.operation === mutation.operation &&
                sameFields(candidate.fields, protectedFields),
            ) ?? -1);
      if (owner && permissionIndex >= 0) {
        usedSqlMigrationTransitions.add(sqlMigrationTransitionUsageKey(owner.id, permissionIndex));
        const permission = owner.transitions[permissionIndex]!;
        const missingPredicates = findMissingSqlPredicates(mutation, permission.requiredPredicates);
        if (missingPredicates.length > 0) {
          diagnostics.push({
            code: "pipeline-cas",
            line: lineAt(file.source, mutation.position),
            message: `${owner.id} writes protected ${mutation.table} state without required SQL expected-state predicate${
              missingPredicates.length === 1 ? "" : "s"
            }: ${missingPredicates.join(", ")}. ${owner.canonicalApi}`,
            path: file.path,
          });
        }
        continue;
      }
      diagnostics.push({
        code: "pipeline-owner",
        line: lineAt(file.source, mutation.position),
        message: owner
          ? `${owner.id} does not permit top-level ${mutation.operation} ${mutation.table} fields ${
              protectedFields?.join(", ") || "(unresolved row lifecycle)"
            }. ${owner.canonicalApi}`
          : `Top-level SQL writes protected ${mutation.table} state outside a named transactional RPC. ${canonicalApiForTable(
              mutation.table,
            )}`,
        path: file.path,
      });
    }
  }

  return diagnostics;
}

type SqlFunctionSpan = {
  body: string;
  bodyStart: number;
  end: number;
  name: string;
  signature: string;
  start: number;
};

function readSqlFunctions(source: string): SqlFunctionSpan[] {
  const spans: SqlFunctionSpan[] = [];
  const startPattern =
    /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][\w]*\.[a-z_][\w]*|[a-z_][\w]*)\s*\(/gi;
  for (const match of source.matchAll(startPattern)) {
    const start = match.index ?? 0;
    const name = match[1]!.toLowerCase();
    const parameterOpen = start + match[0].lastIndexOf("(");
    const parameterClose = findMatchingSqlParenthesis(source, parameterOpen);
    if (parameterClose < 0) continue;
    const signature = `${name}(${readSqlIdentityArgumentTypes(
      source.slice(parameterOpen + 1, parameterClose),
    ).join(",")})`;
    const afterStart = parameterClose + 1;
    const bodyOpenPattern = /\bas\s+(\$[a-z_0-9]*\$)/gi;
    bodyOpenPattern.lastIndex = afterStart;
    const bodyOpen = bodyOpenPattern.exec(source);
    if (!bodyOpen) continue;
    const delimiter = bodyOpen[1]!;
    const bodyStart = bodyOpen.index + bodyOpen[0].length;
    const bodyEnd = source.indexOf(delimiter, bodyStart);
    if (bodyEnd < 0) continue;
    spans.push({
      body: source.slice(bodyStart, bodyEnd),
      bodyStart,
      end: bodyEnd + delimiter.length,
      name,
      signature,
      start,
    });
  }
  return spans;
}

function findMatchingSqlParenthesis(source: string, open: number): number {
  let depth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inSingleQuote) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
    } else if (character === '"') {
      inDoubleQuote = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readSqlIdentityArgumentTypes(parameterSource: string): string[] {
  return splitTopLevelSqlList(parameterSource).flatMap((parameter) => {
    const withoutDefault = parameter.replace(/\s+(?:default\b|=)[\s\S]*$/i, "").trim();
    if (!withoutDefault) return [];
    const tokens = withoutDefault.split(/\s+/);
    const mode = tokens[0]?.toLowerCase();
    if (mode === "out") return [];
    if (mode === "in" || mode === "inout" || mode === "variadic") {
      tokens.shift();
    }
    const typeTokens = tokens.length > 1 ? tokens.slice(1) : tokens;
    return [typeTokens.join(" ").toLowerCase()];
  });
}

function splitTopLevelSqlList(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inSingleQuote) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
    } else if (character === '"') {
      inDoubleQuote = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

type SqlMutation = {
  fields: string[];
  fieldsKnown: boolean;
  operation: MutationOperation;
  predicateSource: string;
  position: number;
  table: ProtectedTable;
  targetAlias: string | null;
};

function readSqlMutations(source: string, offset: number, originalSource = source): SqlMutation[] {
  const mutations: SqlMutation[] = [];
  const updatePattern =
    /\bupdate\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\b(?:\s+(?:as\s+)?([a-z_][\w]*))?\s+set\s+([\s\S]*?)(?=\breturning\b|;|$)/gi;
  for (const match of source.matchAll(updatePattern)) {
    const maskedBody = match[3] ?? "";
    const bodyStart = (match.index ?? 0) + match[0].length - maskedBody.length;
    const originalBody = originalSource.slice(bodyStart, bodyStart + maskedBody.length);
    const whereMatch = /\bwhere\b/i.exec(maskedBody);
    const setClause = whereMatch ? originalBody.slice(0, whereMatch.index) : originalBody;
    const predicateSource = whereMatch
      ? originalBody.slice(whereMatch.index + whereMatch[0].length)
      : "";
    mutations.push({
      fields: readSqlAssignedFields(setClause),
      fieldsKnown: true,
      operation: "update",
      predicateSource,
      position: offset + (match.index ?? 0),
      table: match[1]!.toLowerCase() as ProtectedTable,
      targetAlias: match[2]?.toLowerCase() ?? null,
    });
  }

  const insertPattern =
    /\binsert\s+into\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\b(?:\s*\(([\s\S]*?)\))?/gi;
  for (const match of source.matchAll(insertPattern)) {
    const fieldList = match[2];
    const table = match[1]!.toLowerCase() as ProtectedTable;
    const position = match.index ?? 0;
    mutations.push({
      fields: (fieldList ?? "")
        .split(",")
        .map((field) => field.trim().replaceAll('"', "").toLowerCase())
        .filter(Boolean),
      fieldsKnown: fieldList !== undefined,
      operation: "insert",
      predicateSource: "",
      position: offset + position,
      table,
      targetAlias: null,
    });

    const statementEnd = source.indexOf(";", position);
    const maskedStatement = source.slice(position, statementEnd < 0 ? source.length : statementEnd);
    const conflictUpdate = /\bon\s+conflict\b[\s\S]*?\bdo\s+update\s+set\b/i.exec(maskedStatement);
    if (conflictUpdate) {
      const updateBodyStart = position + conflictUpdate.index + conflictUpdate[0].length;
      const maskedBody = source.slice(
        updateBodyStart,
        statementEnd < 0 ? source.length : statementEnd,
      );
      const originalBody = originalSource.slice(
        updateBodyStart,
        statementEnd < 0 ? originalSource.length : statementEnd,
      );
      const whereMatch = /\bwhere\b/i.exec(maskedBody);
      mutations.push({
        fields: readSqlAssignedFields(
          whereMatch ? originalBody.slice(0, whereMatch.index) : originalBody,
        ),
        fieldsKnown: true,
        operation: "update",
        predicateSource: whereMatch
          ? originalBody.slice(whereMatch.index + whereMatch[0].length)
          : "",
        position: offset + position + conflictUpdate.index,
        table,
        targetAlias: null,
      });
    }
  }

  const deletePattern = /\bdelete\s+from\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\b/gi;
  for (const match of source.matchAll(deletePattern)) {
    mutations.push({
      fields: [],
      fieldsKnown: true,
      operation: "delete",
      predicateSource: readSqlDeletePredicateSource(source, match.index ?? 0),
      position: offset + (match.index ?? 0),
      table: match[1]!.toLowerCase() as ProtectedTable,
      targetAlias: null,
    });
  }
  return mutations;
}

function readExecutedSqlMutations(source: string, offset: number): SqlMutation[] {
  const mutations: SqlMutation[] = [];
  for (const statement of readSqlExecuteStatements(source)) {
    const literalSql = resolveExecutedSql(statement.expression, source, statement.position);
    for (const mutation of readSqlMutations(literalSql, 0)) {
      mutations.push({ ...mutation, position: offset + statement.position });
    }
  }
  return mutations;
}

function resolveExecutedSql(
  expressionSource: string,
  functionSource: string,
  position: number,
): string {
  const executableExpression = stripSqlExecuteClauses(expressionSource);
  const directValues = readSqlStringValues(executableExpression);
  if (directValues.length > 0) {
    return directValues.join(" ");
  }
  const identifier = /^\s*([a-z_][\w]*)\s*$/i.exec(executableExpression)?.[1];
  if (!identifier) {
    return "";
  }
  const assignmentPattern = new RegExp(
    `\\b${escapeRegExp(identifier)}\\s*:=\\s*([\\s\\S]*?);`,
    "gi",
  );
  let latestAssignment: RegExpMatchArray | null = null;
  for (const match of functionSource.slice(0, position).matchAll(assignmentPattern)) {
    latestAssignment = match;
  }
  return latestAssignment ? readSqlStringValues(latestAssignment[1] ?? "").join(" ") : "";
}

function stripSqlExecuteClauses(source: string): string {
  let depth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inSingleQuote) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      continue;
    }
    if (character === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      ["into", "using"].some(
        (keyword) =>
          source.slice(index, index + keyword.length).toLowerCase() === keyword &&
          !/[a-z_0-9]/i.test(source[index - 1] ?? "") &&
          !/[a-z_0-9]/i.test(source[index + keyword.length] ?? ""),
      )
    ) {
      return source.slice(0, index).trim();
    }
  }
  return source.trim();
}

function readSqlDeletePredicateSource(source: string, position: number): string {
  const statementEnd = source.indexOf(";", position);
  const statement = source.slice(position, statementEnd < 0 ? source.length : statementEnd);
  const whereMatch = /\bwhere\b/i.exec(statement);
  return whereMatch ? statement.slice(whereMatch.index + whereMatch[0].length) : "";
}

function readSqlExecuteStatements(source: string): Array<{ expression: string; position: number }> {
  const statements: Array<{ expression: string; position: number }> = [];
  const executePattern = /\bexecute\b/gi;
  for (const match of maskSqlStringLiterals(source).matchAll(executePattern)) {
    const position = match.index ?? 0;
    const expressionStart = position + match[0].length;
    if (/^\s+function\b/i.test(source.slice(expressionStart))) {
      continue;
    }
    let inSingleQuote = false;
    let end = expressionStart;
    for (; end < source.length; end += 1) {
      const character = source[end]!;
      const next = source[end + 1];
      if (inSingleQuote) {
        if (character === "'" && next === "'") {
          end += 1;
        } else if (character === "'") {
          inSingleQuote = false;
        }
      } else if (character === "'") {
        inSingleQuote = true;
      } else if (character === ";") {
        break;
      }
    }
    statements.push({
      expression: source.slice(expressionStart, end),
      position,
    });
  }
  return statements;
}

function readSqlStringValues(source: string): string[] {
  const values: string[] = [];
  let current = "";
  let inSingleQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (!inSingleQuote) {
      if (character === "'") {
        current = "";
        inSingleQuote = true;
      }
      continue;
    }
    if (character === "'" && next === "'") {
      current += "'";
      index += 1;
    } else if (character === "'") {
      values.push(current);
      inSingleQuote = false;
    } else {
      current += character;
    }
  }
  return values;
}

function readProtectedSqlFields(
  mutation: SqlMutation,
  contract: PipelineTransitionContract,
): string[] | null {
  if (!mutation.fieldsKnown) {
    return null;
  }
  const protectedFields = new Set(contract.protectedFields[mutation.table]);
  return mutation.fields.filter((field) => protectedFields.has(field)).sort();
}

function readSqlAssignedFields(setClause: string): string[] {
  const fields = new Set(
    [...setClause.matchAll(/\b([a-z_][\w]*)\s*=/gi)].map((match) => match[1]!.toLowerCase()),
  );
  for (const match of setClause.matchAll(/(?:^|,)\s*\(([^)]+)\)\s*=/gi)) {
    for (const field of (match[1] ?? "").split(",")) {
      const normalized = field.trim().replaceAll('"', "").toLowerCase();
      if (/^[a-z_][\w]*$/.test(normalized)) {
        fields.add(normalized);
      }
    }
  }
  return [...fields];
}

type ObservedSqlPredicate = {
  field: string;
  operator: string;
  qualifier: string | null;
  value: string;
};

function findMissingSqlPredicates(
  mutation: SqlMutation,
  requirements: readonly SqlPredicateRequirement[],
): string[] {
  const observed = readConjunctiveSqlPredicates(mutation.predicateSource);
  return requirements
    .filter(
      (requirement) =>
        !observed.some(
          (candidate) =>
            (candidate.qualifier === null ||
              candidate.qualifier === (mutation.targetAlias ?? mutation.table)) &&
            candidate.field === requirement.field &&
            candidate.operator === requirement.operator &&
            candidate.value === canonicalExpectedSqlPredicateValue(requirement.value),
        ),
    )
    .map(formatSqlPredicateRequirement);
}

function readConjunctiveSqlPredicates(source: string): ObservedSqlPredicate[] {
  if (hasSqlBooleanKeyword(source, "or", true)) {
    return [];
  }
  return splitTopLevelSqlTerms(source, "and").flatMap((term) =>
    hasSqlBooleanKeyword(term, "or", false) ? [] : readSqlPredicates(term),
  );
}

function splitTopLevelSqlTerms(source: string, keyword: "and"): string[] {
  const positions = sqlBooleanKeywordPositions(source, keyword, true);
  const terms: string[] = [];
  let start = 0;
  for (const position of positions) {
    terms.push(source.slice(start, position));
    start = position + keyword.length;
  }
  terms.push(source.slice(start));
  return terms;
}

function hasSqlBooleanKeyword(source: string, keyword: "or", topLevelOnly: boolean): boolean {
  return sqlBooleanKeywordPositions(source, keyword, topLevelOnly).length > 0;
}

function sqlBooleanKeywordPositions(
  source: string,
  keyword: "and" | "or",
  topLevelOnly: boolean,
): number[] {
  const positions: number[] = [];
  let depth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inSingleQuote) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      continue;
    }
    if (character === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      (!topLevelOnly || depth === 0) &&
      source.slice(index, index + keyword.length).toLowerCase() === keyword &&
      !/[a-z_0-9]/i.test(source[index - 1] ?? "") &&
      !/[a-z_0-9]/i.test(source[index + keyword.length] ?? "")
    ) {
      positions.push(index);
      index += keyword.length - 1;
    }
  }
  return positions;
}

function readSqlPredicates(source: string): ObservedSqlPredicate[] {
  const predicates: ObservedSqlPredicate[] = [];
  const pattern =
    /\b(?:([a-z_][\w]*)\.)?([a-z_][\w]*)\s*(is\s+not|is|<>|!=|=)\s*('(?:''|[^'])*'|null|true|false|-?\d+(?:\.\d+)?|[a-z_][\w]*(?:\.[a-z_][\w]*)?)/gi;
  for (const match of source.matchAll(pattern)) {
    predicates.push({
      field: match[2]!.toLowerCase(),
      operator: match[3]!.replace(/\s+/g, " ").toLowerCase(),
      qualifier: match[1]?.toLowerCase() ?? null,
      value: canonicalObservedSqlPredicateValue(match[4]!),
    });
  }
  return predicates;
}

function canonicalObservedSqlPredicateValue(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith("'")) {
    return canonicalScalar(readSqlStringValues(normalized)[0] ?? "");
  }
  if (normalized.toLowerCase() === "null") return canonicalScalar(null);
  if (normalized.toLowerCase() === "true") return canonicalScalar(true);
  if (normalized.toLowerCase() === "false") return canonicalScalar(false);
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return canonicalScalar(Number(normalized));
  return `expression:${normalizeExpressionText(normalized.toLowerCase())}`;
}

function canonicalExpectedSqlPredicateValue(value: PredicateValue): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "expression" in value
  ) {
    return `expression:${normalizeExpressionText(value.expression.toLowerCase())}`;
  }
  return canonicalExpectedPredicateValue(value);
}

function formatSqlPredicateRequirement(requirement: SqlPredicateRequirement): string {
  const value =
    typeof requirement.value === "object" &&
    requirement.value !== null &&
    !Array.isArray(requirement.value) &&
    "expression" in requirement.value
      ? requirement.value.expression
      : JSON.stringify(requirement.value);
  return `${requirement.field} ${requirement.operator} ${value}`;
}

function maskSpans(source: string, spans: readonly SqlFunctionSpan[]): string {
  const characters = [...source];
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function maskSqlComments(source: string): string {
  const characters = [...source];
  let blockDepth = 0;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inSingleQuote = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
      } else {
        characters[index] = " ";
      }
      continue;
    }

    if (blockDepth > 0) {
      if (character === "/" && next === "*") {
        characters[index] = " ";
        characters[index + 1] = " ";
        blockDepth += 1;
        index += 1;
      } else if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        blockDepth -= 1;
        index += 1;
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }

    if (inSingleQuote) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      characters[index] = " ";
      characters[index + 1] = " ";
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      blockDepth = 1;
      index += 1;
    } else if (character === "'") {
      inSingleQuote = true;
    } else if (character === '"') {
      inDoubleQuote = true;
    }
  }

  return characters.join("");
}

function maskSqlStringLiterals(source: string): string {
  const characters = [...source];
  let inLiteral = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    if (!inLiteral) {
      if (character === "'") {
        characters[index] = " ";
        inLiteral = true;
      }
      continue;
    }

    if (character === "'" && next === "'") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
    } else if (character === "'") {
      characters[index] = " ";
      inLiteral = false;
    } else if (character !== "\n") {
      characters[index] = " ";
    }
  }

  return characters.join("");
}

function sqlBranchesOnSeededStage(source: string, seededSlugs: readonly string[]): boolean {
  const slugAlternation = seededSlugs.join("|");
  return new RegExp(
    `(?:stage[_a-z]*|slug)\\s*(?:=|<>|!=)\\s*['"](?:${slugAlternation})['"]|case\\s+(?:stage[_a-z]*|slug)[\\s\\S]{0,160}?when\\s+['"](?:${slugAlternation})['"]`,
    "i",
  ).test(source);
}

function diagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: PipelineContractDiagnostic["code"],
  message: string,
): PipelineContractDiagnostic {
  return {
    code,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    message,
    path: normalizePath(sourceFile.fileName),
  };
}

function canonicalApiForTable(table: ProtectedTable): string {
  if (table === "sessions") return CANONICAL_SESSION_API;
  if (table === "agent_jobs") return CANONICAL_JOB_API;
  return CANONICAL_RUN_API;
}

function lineAt(source: string, position: number): number {
  return source.slice(0, position).split("\n").length;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isDefaultAdapterPath(path: string, adapters: readonly string[]): boolean {
  return adapters.some((adapter) =>
    adapter.endsWith("/") ? path.startsWith(adapter) : path === adapter,
  );
}

function isProtectedTable(value: string | null): value is ProtectedTable {
  return value === "agent_jobs" || value === "agent_runs" || value === "sessions";
}

function recoveryTransitionUsageKey(ownerId: string, transitionIndex: number): string {
  return `${ownerId}:${transitionIndex}`;
}

function sqlMigrationTransitionUsageKey(ownerId: string, transitionIndex: number): string {
  return `${ownerId}:${transitionIndex}`;
}

function sourceDeclaresFunction(source: string, functionName: string): boolean {
  return new RegExp(
    `\\b(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\b|\\b${escapeRegExp(
      functionName,
    )}\\s*=\\s*(?:async\\s*)?\\(`,
  ).test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
