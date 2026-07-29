import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";

type ProtectedTable = "agent_jobs" | "agent_runs" | "sessions";
type MutationOperation = "delete" | "insert" | "update" | "upsert";

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
  requiredPredicates: readonly string[];
  table: ProtectedTable;
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
  transitions: readonly SqlTransitionPermission[];
};

type SqlTransitionPermission = {
  fields: readonly string[];
  operation: MutationOperation;
  table: ProtectedTable;
};

export type PipelineTransitionContract = {
  defaultAdapterPaths: readonly string[];
  ordinaryOwners: readonly TransitionOwner[];
  protectedFields: Readonly<Record<ProtectedTable, readonly string[]>>;
  recoveryOwners: readonly RecoveryOwner[];
  seededStageSlugs: readonly string[];
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
  requiredPredicates: readonly string[] = [],
): TransitionPermission {
  return { fields, functionName, operation, requiredPredicates, table };
}

function sqlTransition(
  table: ProtectedTable,
  operation: MutationOperation,
  fields: readonly string[],
): SqlTransitionPermission {
  return { fields, operation, table };
}

export const PIPELINE_TRANSITION_CONTRACT: PipelineTransitionContract = {
  protectedFields: {
    agent_jobs: ["attempt_count", "finished_at", "scheduled_at", "started_at", "status"],
    agent_runs: ["finished_at", "last_activity_at", "sandbox_id", "started_at", "status"],
    sessions: [
      "archived_at",
      "current_artifact_version",
      "current_stage_id",
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
          ["archived_at", "phase_status"],
        ),
        transition(
          "runStage",
          "sessions",
          "update",
          ["current_artifact_version", "phase_status"],
          ["archived_at", "phase_status"],
        ),
        transition(
          "handleRejection",
          "sessions",
          "update",
          ["rejection_count"],
          ["archived_at", "current_artifact_version", "phase_status", "rejection_count"],
        ),
        transition(
          "handleRejection",
          "sessions",
          "update",
          ["phase_status"],
          ["archived_at", "current_artifact_version", "phase_status", "rejection_count"],
        ),
        transition("updateSessionStatus", "sessions", "update", ["phase_status"], ["phase_status"]),
        transition(
          "updateSessionStatusAfterStageFailure",
          "sessions",
          "update",
          ["current_artifact_version", "phase_status"],
          ["phase_status"],
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      id: "pipeline-job-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition("cleanupQueuedJob", "agent_jobs", "delete", [], ["status"]),
        transition("enqueueSessionJobWithRun", "agent_jobs", "insert", []),
        transition(
          "markPipelineJobSuccess",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          ["status"],
        ),
        transition(
          "markPipelineJobError",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          ["status"],
        ),
      ],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      id: "pipeline-run-transitions",
      path: "src/lib/pipeline/processor.ts",
      transitions: [
        transition("enqueueSessionJobWithRun", "agent_runs", "insert", []),
        transition("startAgentRun", "agent_runs", "update", ["started_at", "status"], ["status"]),
        transition("startAgentRun", "agent_runs", "insert", ["started_at", "status"]),
        transition("updateRunSandbox", "agent_runs", "update", ["sandbox_id"], ["status"]),
        transition("markRunSuccess", "agent_runs", "update", ["finished_at", "status"], ["status"]),
        transition("markRunError", "agent_runs", "update", ["finished_at", "status"], ["status"]),
        transition("touchRunActivity", "agent_runs", "update", ["last_activity_at"], ["status"]),
      ],
    },
    {
      canonicalApi: "Use archiveSession()/unarchiveSession().",
      id: "session-archive-transitions",
      path: "src/lib/pipeline/archive.ts",
      transitions: [
        transition("archiveSession", "sessions", "update", ["archived_at"], ["archived_at"]),
        transition("unarchiveSession", "sessions", "update", ["archived_at"], ["archived_at"]),
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
          ["status"],
        ),
        transition("cleanupQueuedJob", "agent_jobs", "delete", [], ["status"]),
        transition("createQueuedRun", "agent_jobs", "insert", []),
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
        transition("markJobError", "agent_jobs", "update", ["finished_at", "status"], ["status"]),
      ],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      id: "worker-run-activity-transition",
      path: "src/worker/loop.ts",
      transitions: [
        transition("runClaimedJob", "agent_runs", "update", ["last_activity_at"], ["status"]),
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
          ["status"],
        ),
        transition(
          "cancelSessionWork",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          ["status"],
        ),
        transition("cancelSessionWork", "sessions", "update", ["phase_status"], ["phase_status"]),
        transition(
          "cancelWorkspaceWork",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          ["status"],
        ),
        transition(
          "cancelWorkspaceWork",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          ["status"],
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
          ["phase_status"],
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
          ["phase_status"],
        ),
        transition("ensurePipelineJobQueued", "agent_jobs", "insert", []),
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
          ["status"],
        ),
        transition("sweepStalledRuns", "sessions", "update", ["phase_status"], ["phase_status"]),
        transition(
          "resolveStalledJob",
          "agent_jobs",
          "update",
          ["finished_at", "status"],
          ["status"],
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
          ["status"],
        ),
        transition(
          "markActiveRunsForJobError",
          "agent_runs",
          "update",
          ["finished_at", "status"],
          ["status"],
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
          ["phase_status"],
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
      transitions: [
        sqlTransition("sessions", "update", ["phase_status"]),
        sqlTransition("sessions", "update", ["archived_at"]),
        sqlTransition("sessions", "update", [
          "current_artifact_version",
          "current_stage_id",
          "phase_status",
          "rejection_count",
        ]),
      ],
    },
    {
      canonicalApi: "Use the claim_agent_job transactional RPC.",
      functionName: "public.claim_agent_job",
      id: "legacy-job-claim-rpc",
      transitions: [
        sqlTransition("agent_jobs", "update", [
          "attempt_count",
          "scheduled_at",
          "started_at",
          "status",
        ]),
      ],
    },
    {
      canonicalApi: "Use the claim_next_agent_job transactional RPC.",
      functionName: "public.claim_next_agent_job",
      id: "worker-job-claim-rpc",
      transitions: [
        sqlTransition("agent_jobs", "update", [
          "attempt_count",
          "scheduled_at",
          "started_at",
          "status",
        ]),
      ],
    },
    {
      canonicalApi: "Use the schedule_job_retry transactional RPC.",
      functionName: "public.schedule_job_retry",
      id: "job-retry-rpc",
      transitions: [
        sqlTransition("agent_jobs", "update", ["finished_at", "scheduled_at", "status"]),
      ],
    },
    {
      canonicalApi: "Use the create_session_with_first_job transactional RPC.",
      functionName: "public.create_session_with_first_job",
      id: "session-create-rpc",
      transitions: [
        sqlTransition("sessions", "insert", ["current_stage_id", "phase_status"]),
        sqlTransition("agent_jobs", "insert", ["status"]),
        sqlTransition("agent_runs", "insert", ["status"]),
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
};

type BindingSource = Initializer & {
  propertyName: string | null;
};

type SourceContext = {
  bindingSources: Map<string, BindingSource[]>;
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

  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    if (normalizedPath.endsWith(".sql")) {
      diagnostics.push(...verifySqlFile({ ...file, path: normalizedPath }, contract));
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

  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
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
      entries.push({ expression: node.initializer, position: node.getStart(sourceFile) });
      initializers.set(node.name.text, entries);
    }
  });
  return initializers;
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
    const initializer = nearestInitializer(context.initializers.get(expression.text), position);
    if (initializer) {
      return resolveExpression(initializer.expression, position, context, seen);
    }
  }
  return expression;
}

function nearestInitializer(
  initializers: readonly Initializer[] | undefined,
  position: number,
): Initializer | null {
  return (
    initializers
      ?.filter((initializer) => initializer.position < position)
      .sort((left, right) => right.position - left.position)[0] ?? null
  );
}

function nearestBindingSource(
  sources: readonly BindingSource[] | undefined,
  position: number,
): BindingSource | null {
  return (
    sources
      ?.filter((source) => source.position < position)
      .sort((left, right) => right.position - left.position)[0] ?? null
  );
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
  requiredPredicates: readonly string[],
): string[] {
  const predicateFields = new Set<string>();
  collectOuterPredicates(mutation.call, mutation.call.getStart(), context, predicateFields);

  return requiredPredicates.filter((field) => !predicateFields.has(field));
}

function collectOuterPredicates(
  mutationCall: ts.CallExpression,
  position: number,
  context: SourceContext,
  fields: Set<string>,
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
      if (field) fields.add(field);
    }
    expression = outerCall;
  }
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

function isSeededStageBranch(
  node: ts.Node,
  context: SourceContext,
  seededSlugs: readonly string[],
): boolean {
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

  const initializer = nearestInitializer(context.initializers.get(name), position);
  if (initializer) {
    return isStageSlugExpression(initializer.expression, position, context, seen);
  }

  const binding = nearestBindingSource(context.bindingSources.get(name), position);
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
    const initializer = nearestInitializer(context.initializers.get(unwrapped.text), position);
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
): PipelineContractDiagnostic[] {
  const diagnostics: PipelineContractDiagnostic[] = [];
  const commentMaskedSource = maskSqlComments(file.source);
  const functionSpans = readSqlFunctions(commentMaskedSource);

  for (const sqlFunction of functionSpans) {
    const owner = contract.sqlOwners.find(
      (candidate) => candidate.functionName === sqlFunction.name,
    );
    const mutations = [
      ...readSqlMutations(maskSqlStringLiterals(sqlFunction.body), sqlFunction.bodyStart),
      ...readExecutedSqlMutations(sqlFunction.body, sqlFunction.bodyStart),
    ];
    for (const mutation of mutations) {
      const protectedFields = readProtectedSqlFields(mutation, contract);
      const writesProtectedState =
        mutation.operation === "delete" ||
        mutation.operation === "insert" ||
        protectedFields.length > 0;
      if (!writesProtectedState) continue;
      const permission = owner?.transitions.find(
        (candidate) =>
          candidate.table === mutation.table &&
          candidate.operation === mutation.operation &&
          sameFields(candidate.fields, protectedFields),
      );
      if (!permission) {
        const ownerMessage = owner
          ? `${owner.id} does not permit ${mutation.operation} ${mutation.table} fields ${
              protectedFields.join(", ") || "(row lifecycle)"
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
  for (const mutation of readSqlMutations(maskSqlStringLiterals(maskedSource), 0)) {
    const protectedFields = readProtectedSqlFields(mutation, contract);
    const writesProtectedState =
      mutation.operation === "delete" ||
      mutation.operation === "insert" ||
      protectedFields.length > 0;
    if (writesProtectedState) {
      diagnostics.push({
        code: "pipeline-owner",
        line: lineAt(file.source, mutation.position),
        message: `Top-level SQL writes protected ${mutation.table} state outside a named transactional RPC. ${canonicalApiForTable(
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
  start: number;
};

function readSqlFunctions(source: string): SqlFunctionSpan[] {
  const spans: SqlFunctionSpan[] = [];
  const startPattern =
    /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][\w]*\.[a-z_][\w]*|[a-z_][\w]*)\s*\(/gi;
  for (const match of source.matchAll(startPattern)) {
    const start = match.index ?? 0;
    const afterStart = start + match[0].length;
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
      name: match[1]!.toLowerCase(),
      start,
    });
  }
  return spans;
}

type SqlMutation = {
  fields: string[];
  operation: MutationOperation;
  position: number;
  table: ProtectedTable;
};

function readSqlMutations(source: string, offset: number): SqlMutation[] {
  const mutations: SqlMutation[] = [];
  const updatePattern =
    /\bupdate\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\b(?:\s+(?:as\s+)?[a-z_][\w]*)?\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|;)/gi;
  for (const match of source.matchAll(updatePattern)) {
    mutations.push({
      fields: readSqlAssignedFields(match[2] ?? ""),
      operation: "update",
      position: offset + (match.index ?? 0),
      table: match[1]!.toLowerCase() as ProtectedTable,
    });
  }

  const insertPattern =
    /\binsert\s+into\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\s*\(([\s\S]*?)\)/gi;
  for (const match of source.matchAll(insertPattern)) {
    mutations.push({
      fields: (match[2] ?? "")
        .split(",")
        .map((field) => field.trim().replaceAll('"', "").toLowerCase())
        .filter(Boolean),
      operation: "insert",
      position: offset + (match.index ?? 0),
      table: match[1]!.toLowerCase() as ProtectedTable,
    });
  }

  const deletePattern = /\bdelete\s+from\s+(?:public\.)?(sessions|agent_jobs|agent_runs)\b/gi;
  for (const match of source.matchAll(deletePattern)) {
    mutations.push({
      fields: [],
      operation: "delete",
      position: offset + (match.index ?? 0),
      table: match[1]!.toLowerCase() as ProtectedTable,
    });
  }
  return mutations;
}

function readExecutedSqlMutations(source: string, offset: number): SqlMutation[] {
  const mutations: SqlMutation[] = [];
  for (const statement of readSqlExecuteStatements(source)) {
    const literalSql = readSqlStringValues(statement.expression).join(" ");
    for (const mutation of readSqlMutations(literalSql, 0)) {
      mutations.push({ ...mutation, position: offset + statement.position });
    }
  }
  return mutations;
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
): string[] {
  const protectedFields = new Set(contract.protectedFields[mutation.table]);
  return mutation.fields.filter((field) => protectedFields.has(field)).sort();
}

function readSqlAssignedFields(setClause: string): string[] {
  return [...setClause.matchAll(/\b([a-z_][\w]*)\s*=/gi)].map((match) => match[1]!.toLowerCase());
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
