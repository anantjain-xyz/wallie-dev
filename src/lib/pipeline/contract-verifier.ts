import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";

type ProtectedTable = "agent_jobs" | "agent_runs" | "sessions";
type MutationOperation = "insert" | "update" | "upsert";

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
  functions: readonly string[];
  id: string;
  path: string;
  tables: readonly ProtectedTable[];
};

type RecoveryOwner = TransitionOwner & {
  category: "cancellation" | "reaper" | "reconciler" | "repair" | "stall-detector";
  requiredMarkers?: readonly string[];
};

type SqlTransitionOwner = {
  canonicalApi: string;
  functionName: string;
  id: string;
  tables: readonly ProtectedTable[];
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

export const PIPELINE_TRANSITION_CONTRACT: PipelineTransitionContract = {
  protectedFields: {
    agent_jobs: ["attempt_count", "finished_at", "scheduled_at", "started_at", "status"],
    agent_runs: ["finished_at", "last_activity_at", "sandbox_id", "started_at", "status"],
    sessions: ["archived_at", "current_artifact_version", "current_stage_id", "phase_status"],
  },
  ordinaryOwners: [
    {
      canonicalApi: CANONICAL_SESSION_API,
      functions: [
        "processPipelineJob",
        "runStage",
        "handleRejection",
        "updateSessionStatus",
        "updateSessionStatusAfterStageFailure",
      ],
      id: "pipeline-session-transitions",
      path: "src/lib/pipeline/processor.ts",
      tables: ["sessions"],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      functions: ["enqueueSessionJobWithRun", "markPipelineJobSuccess", "markPipelineJobError"],
      id: "pipeline-job-transitions",
      path: "src/lib/pipeline/processor.ts",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      functions: [
        "enqueueSessionJobWithRun",
        "startAgentRun",
        "updateRunSandbox",
        "markRunSuccess",
        "markRunError",
        "touchRunActivity",
      ],
      id: "pipeline-run-transitions",
      path: "src/lib/pipeline/processor.ts",
      tables: ["agent_runs"],
    },
    {
      canonicalApi: "Use archiveSession()/unarchiveSession().",
      functions: ["archiveSession", "unarchiveSession"],
      id: "session-archive-transitions",
      path: "src/lib/pipeline/archive.ts",
      tables: ["sessions"],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      functions: ["createQueuedRun", "claimJobIfQueued"],
      id: "wallie-job-transitions",
      path: "src/lib/wallie/service.ts",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      functions: ["createQueuedRun"],
      id: "wallie-run-transitions",
      path: "src/lib/wallie/service.ts",
      tables: ["agent_runs"],
    },
    {
      canonicalApi: CANONICAL_JOB_API,
      functions: ["markJobError"],
      id: "worker-job-result-transition",
      path: "src/worker/loop.ts",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: CANONICAL_RUN_API,
      functions: ["runClaimedJob"],
      id: "worker-run-activity-transition",
      path: "src/worker/loop.ts",
      tables: ["agent_runs"],
    },
  ],
  recoveryOwners: [
    {
      canonicalApi: "Use cancelSessionWork()/cancelWorkspaceWork().",
      category: "cancellation",
      functions: ["cancelSessionWork", "cancelWorkspaceWork"],
      id: "cancellation-transitions",
      path: "src/lib/pipeline/cancel.ts",
      tables: ["agent_jobs", "agent_runs", "sessions"],
    },
    {
      canonicalApi: "Use reconcileLinearState() and its owned routing helpers.",
      category: "reconciler",
      functions: ["archiveSessionForLinearRoute", "routeSessionToStage", "ensurePipelineJobQueued"],
      id: "linear-reconciler-transitions",
      path: "src/worker/reconciler.ts",
      tables: ["agent_jobs", "sessions"],
    },
    {
      canonicalApi: "Use sweepStalledRuns() and resolveStalledJob().",
      category: "stall-detector",
      functions: ["sweepStalledRuns", "resolveStalledJob"],
      id: "stall-detector-transitions",
      path: "src/worker/stall-detector.ts",
      tables: ["agent_jobs", "agent_runs", "sessions"],
    },
    {
      canonicalApi: "Use the processor's guarded cleanup helpers.",
      category: "repair",
      functions: ["cancelQueuedRunsForJob", "markActiveRunsForJobError"],
      id: "processor-repair-transitions",
      path: "src/lib/pipeline/processor.ts",
      tables: ["agent_runs"],
    },
    {
      canonicalApi: "Use the workspace-delete compensating parkGeneratingSessions() helper.",
      category: "repair",
      functions: ["parkGeneratingSessions"],
      id: "workspace-delete-repair-transition",
      path: "src/app/api/workspaces/[workspaceId]/route.ts",
      tables: ["sessions"],
    },
    {
      canonicalApi: "Use runMaintenanceTick() to compose named recovery owners.",
      category: "repair",
      functions: ["runMaintenanceTick"],
      id: "manual-repair-orchestrator",
      path: "src/lib/maintenance/service.ts",
      requiredMarkers: ["sweepStalledRuns(", "reapOrphanSandboxes(", "reconcileLinearState("],
      tables: [],
    },
    {
      canonicalApi: "Use reapOrphanSandboxes() for provider cleanup.",
      category: "reaper",
      functions: ["reapOrphanSandboxes"],
      id: "sandbox-reaper",
      path: "src/worker/sandbox-reaper.ts",
      requiredMarkers: ['.from("agent_runs")', '.from("agent_jobs")', "status"],
      tables: [],
    },
  ],
  sqlOwners: [
    {
      canonicalApi: "Use the approve_session_stage transactional RPC.",
      functionName: "public.approve_session_stage",
      id: "stage-approval-rpc",
      tables: ["sessions"],
    },
    {
      canonicalApi: "Use the claim_agent_job transactional RPC.",
      functionName: "public.claim_agent_job",
      id: "legacy-job-claim-rpc",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: "Use the claim_next_agent_job transactional RPC.",
      functionName: "public.claim_next_agent_job",
      id: "worker-job-claim-rpc",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: "Use the schedule_job_retry transactional RPC.",
      functionName: "public.schedule_job_retry",
      id: "job-retry-rpc",
      tables: ["agent_jobs"],
    },
    {
      canonicalApi: "Use the create_session_with_first_job transactional RPC.",
      functionName: "public.create_session_with_first_job",
      id: "session-create-rpc",
      tables: ["agent_jobs", "agent_runs", "sessions"],
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

const MUTATION_OPERATIONS = new Set<MutationOperation>(["insert", "update", "upsert"]);
const EXPECTED_STATE_FIELDS: Readonly<Record<ProtectedTable, readonly string[]>> = {
  agent_jobs: ["attempt_count", "status"],
  agent_runs: ["status"],
  sessions: ["archived_at", "current_artifact_version", "current_stage_id", "phase_status"],
};
const PREDICATE_METHODS = new Set(["eq", "in", "is", "neq", "not"]);

type Initializer = {
  expression: ts.Expression;
  position: number;
};

type SourceContext = {
  initializers: Map<string, Initializer[]>;
  sourceFile: ts.SourceFile;
};

type Mutation = {
  call: ts.CallExpression;
  fields: Set<string>;
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
  const usedRecoveryFunctions = new Set<string>();

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
      initializers: collectInitializers(sourceFile),
      sourceFile,
    };

    walk(sourceFile, (node) => {
      if (ts.isCallExpression(node)) {
        const mutation = readMutation(node, context);
        if (mutation) {
          const writesProtectedState =
            mutation.operation === "insert" ||
            [...mutation.fields].some((field) =>
              contract.protectedFields[mutation.table].includes(field),
            );
          if (writesProtectedState) {
            const recoveryOwner = findTransitionOwner(
              contract.recoveryOwners,
              normalizedPath,
              mutation,
            );
            const ordinaryOwner = findTransitionOwner(
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
              if (recoveryOwner && mutation.functionName) {
                usedRecoveryFunctions.add(
                  recoveryUsageKey(recoveryOwner.id, mutation.functionName),
                );
              }
              if (
                mutation.operation !== "insert" &&
                !hasExpectedStatePredicate(mutation, context)
              ) {
                diagnostics.push(
                  diagnostic(
                    context.sourceFile,
                    mutation.call,
                    "pipeline-cas",
                    `${owner.id} writes protected ${mutation.table} state without an expected-state predicate. ${owner.canonicalApi}`,
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
    for (const functionName of recoveryOwner.functions) {
      const used =
        recoveryOwner.tables.length > 0
          ? usedRecoveryFunctions.has(recoveryUsageKey(recoveryOwner.id, functionName))
          : Boolean(file && sourceDeclaresFunction(file.source, functionName));
      if (!used) {
        diagnostics.push({
          code: "recovery-owner-unused",
          line: 1,
          message: `${recoveryOwner.category} exception ${recoveryOwner.id} declares ${functionName} but no matching owned path uses it. Remove the stale exception or restore the canonical recovery path.`,
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

  return {
    call,
    fields: readObjectFields(call.arguments[0], call.getStart(), context),
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
): Set<string> {
  if (!expression) return new Set();
  const resolved = resolveExpression(expression, position, context);
  if (seen.has(resolved) || !ts.isObjectLiteralExpression(resolved)) {
    return new Set();
  }
  seen.add(resolved);
  const fields = new Set<string>();
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const field of readObjectFields(property.expression, position, context, seen)) {
        fields.add(field);
      }
      continue;
    }
    const name = property.name && propertyName(property.name);
    if (name) fields.add(name);
  }
  return fields;
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

function findTransitionOwner<T extends TransitionOwner>(
  owners: readonly T[],
  path: string,
  mutation: Mutation,
): T | null {
  return (
    owners.find(
      (owner) =>
        owner.path === path &&
        owner.tables.includes(mutation.table) &&
        Boolean(mutation.functionName && owner.functions.includes(mutation.functionName)),
    ) ?? null
  );
}

function hasExpectedStatePredicate(mutation: Mutation, context: SourceContext): boolean {
  const predicateFields = new Set<string>();
  collectOuterPredicates(mutation.call, mutation.call.getStart(), context, predicateFields);

  const alias = mutationAlias(mutation.call);
  if (alias) {
    const functionNode = enclosingFunctionNode(mutation.call) ?? context.sourceFile;
    walk(functionNode, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === alias &&
        PREDICATE_METHODS.has(node.expression.name.text)
      ) {
        const field = readString(node.arguments[0], node.getStart(), context);
        if (field) predicateFields.add(field);
      }
    });
  }

  return EXPECTED_STATE_FIELDS[mutation.table].some((field) => predicateFields.has(field));
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

function mutationAlias(call: ts.CallExpression): string | null {
  let current: ts.Node = call;
  while (current.parent) {
    if (
      ts.isVariableDeclaration(current.parent) &&
      current.parent.initializer &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (
      ts.isExpressionStatement(current.parent) ||
      ts.isReturnStatement(current.parent) ||
      ts.isBlock(current.parent)
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function enclosingFunctionNode(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function isSeededStageBranch(
  node: ts.Node,
  context: SourceContext,
  seededSlugs: readonly string[],
): boolean {
  if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind)) {
    return (
      (isStageSlugExpression(node.left) &&
        isSeededSlugExpression(node.right, node.getStart(), context, seededSlugs)) ||
      (isStageSlugExpression(node.right) &&
        isSeededSlugExpression(node.left, node.getStart(), context, seededSlugs))
    );
  }
  if (ts.isCaseClause(node) && node.parent.parent) {
    const switchStatement = node.parent.parent;
    return (
      ts.isSwitchStatement(switchStatement) &&
      isStageSlugExpression(switchStatement.expression) &&
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

function isStageSlugExpression(expression: ts.Expression): boolean {
  const text = expression.getText().toLowerCase();
  return text.includes("stage") && (text.includes("slug") || text.endsWith(".stage"));
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
  const functionSpans = readSqlFunctions(file.source);

  for (const sqlFunction of functionSpans) {
    const owner = contract.sqlOwners.find(
      (candidate) => candidate.functionName === sqlFunction.name,
    );
    for (const mutation of readSqlMutations(sqlFunction.body, sqlFunction.bodyStart)) {
      const protectedFields = contract.protectedFields[mutation.table];
      const writesProtectedState =
        mutation.operation === "insert" ||
        mutation.fields.some((field) => protectedFields.includes(field));
      if (!writesProtectedState) continue;
      if (!owner || !owner.tables.includes(mutation.table)) {
        diagnostics.push({
          code: "pipeline-owner",
          line: lineAt(file.source, mutation.position),
          message: `SQL function ${sqlFunction.name} writes protected ${mutation.table} state without owning that transition. ${canonicalApiForTable(
            mutation.table,
          )}`,
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

  const maskedSource = maskSpans(file.source, functionSpans);
  for (const mutation of readSqlMutations(maskedSource, 0)) {
    const protectedFields = contract.protectedFields[mutation.table];
    const writesProtectedState =
      mutation.operation === "insert" ||
      mutation.fields.some((field) => protectedFields.includes(field));
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
  return mutations;
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

function recoveryUsageKey(ownerId: string, functionName: string): string {
  return `${ownerId}:${functionName}`;
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
