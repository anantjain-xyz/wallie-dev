import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { pipelineTransitionBoundaryConfig } from "./pipeline-transition-boundaries.config";

export type PipelineTable =
  | "agent_jobs"
  | "agent_runs"
  | "session_artifact_feedback"
  | "session_artifacts"
  | "session_phase_completions"
  | "sessions";
export type PipelineOperation = "delete" | "insert" | "select" | "update" | "upsert";
export type RecoveryCategory =
  | "cancellation"
  | "reaper"
  | "reconciler"
  | "repair"
  | "stall-detector";

export type PipelineMutationOwner = Readonly<{
  callers: readonly string[];
  canonicalApi: string;
  functionName: string;
  operation: Exclude<PipelineOperation, "select">;
  path: string;
  recovery?: RecoveryCategory;
  table: PipelineTable;
}>;

export type PipelineRecoveryReadOwner = Readonly<{
  category: RecoveryCategory;
  functionName: string;
  path: string;
  table: PipelineTable;
}>;

export type PipelineRpcOwner = Readonly<{
  callers: readonly string[];
  canonicalApi: string;
  functionName: string;
  latestMigration: string;
  path: string;
  rpc: string;
}>;

export type PipelineDynamicTableException = Readonly<{
  functionName: string;
  owner: string;
  path: string;
  reason: string;
}>;

export type PipelineImportPermission = Readonly<{
  callers: readonly string[];
  name: string;
}>;

export type PipelineSqlFileOwner = Readonly<{
  owner: string;
  path: string;
  reason: string;
}>;

export type SeededStageLiteralException = Readonly<{
  functionName: string;
  owner: string;
  path: string;
  reason: string;
  value: string;
}>;

export type PipelineTransitionBoundaryConfig = Readonly<{
  dynamicTableExceptions: readonly PipelineDynamicTableException[];
  genericStageSourceRoots: readonly string[];
  importPermissions: readonly PipelineImportPermission[];
  mutationOwners: readonly PipelineMutationOwner[];
  protectedTables: readonly PipelineTable[];
  recoveryReadOwners: readonly PipelineRecoveryReadOwner[];
  rpcOwners: readonly PipelineRpcOwner[];
  seededStageAdapters: readonly string[];
  seededStageLiteralExceptions: readonly SeededStageLiteralException[];
  seededStageSlugs: readonly string[];
  sourceRoots: readonly string[];
  sqlFileOwners: readonly PipelineSqlFileOwner[];
  transitionModule: string;
}>;

export type PipelineTransitionDiagnosticCode =
  | "dynamic-rpc-access"
  | "dynamic-table-access"
  | "invalid-config"
  | "pipeline-owner"
  | "recovery-owner-unused"
  | "seeded-stage-branch"
  | "sql-owner"
  | "unauthorized-transition-import"
  | "unbound-table-access"
  | "unused-owner";

export type PipelineTransitionDiagnostic = Readonly<{
  code: PipelineTransitionDiagnosticCode;
  line: number;
  message: string;
  path: string;
}>;

export type PipelineTransitionFile = Readonly<{
  path: string;
  source: string;
}>;

type VerifyInput = Readonly<{
  config: PipelineTransitionBoundaryConfig;
  files: readonly PipelineTransitionFile[];
}>;

const MUTATION_OPERATIONS = new Set<PipelineOperation>(["delete", "insert", "update", "upsert"]);
const TEST_FILE_PATTERN = /\.(?:fixture|spec|test|typecheck)\.[cm]?[jt]sx?$/;

function normalizePath(path: string) {
  return path.split(sep).join("/");
}

function walkFiles(root: string, extensions: ReadonlySet<string>): string[] {
  if (!statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return walkFiles(path, extensions);
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return extensions.has(extension) ? [path] : [];
  });
}

export function loadPipelineTransitionFiles(projectRoot = process.cwd()): PipelineTransitionFile[] {
  return [
    ...walkFiles(resolve(projectRoot, "src"), new Set([".cts", ".mts", ".ts", ".tsx"])),
    ...walkFiles(resolve(projectRoot, "supabase/migrations"), new Set([".sql"])),
  ].map((path) => ({
    path: normalizePath(relative(projectRoot, path)),
    source: readFileSync(path, "utf8"),
  }));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function propertyReceiver(expression: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expression.expression;
  }
  return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
  let outermostFunction: ts.Node | null = null;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) outermostFunction = current;
  }
  if (
    outermostFunction &&
    ts.isFunctionDeclaration(outermostFunction) &&
    outermostFunction.name &&
    ts.isSourceFile(outermostFunction.parent)
  ) {
    return outermostFunction.name.text;
  }
  if (
    outermostFunction &&
    (ts.isArrowFunction(outermostFunction) || ts.isFunctionExpression(outermostFunction)) &&
    ts.isVariableDeclaration(outermostFunction.parent) &&
    ts.isIdentifier(outermostFunction.parent.name) &&
    ts.isVariableDeclarationList(outermostFunction.parent.parent) &&
    ts.isVariableStatement(outermostFunction.parent.parent.parent) &&
    ts.isSourceFile(outermostFunction.parent.parent.parent.parent)
  ) {
    return outermostFunction.parent.name.text;
  }
  return null;
}

function directOperation(fromCall: ts.CallExpression): PipelineOperation | null {
  const access = fromCall.parent;
  if (
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    access.expression !== fromCall
  ) {
    return null;
  }
  const operation = propertyName(access);
  if (!operation || !["delete", "insert", "select", "update", "upsert"].includes(operation)) {
    return null;
  }
  return operation as PipelineOperation;
}

function ownerKey(
  path: string,
  functionName: string,
  table: PipelineTable,
  operation: PipelineOperation,
) {
  return `${path}\0${functionName}\0${table}\0${operation}`;
}

function callerKey(name: string, path: string) {
  return `${name}\0${path}`;
}

function isWithin(path: string, roots: readonly string[]) {
  return roots.some(
    (root) =>
      root === "" || path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
}

function invalidConfigDiagnostics(config: PipelineTransitionBoundaryConfig) {
  const diagnostics: PipelineTransitionDiagnostic[] = [];
  const seenOwners = new Set<string>();
  const seenImports = new Set<string>();
  const seenSqlFiles = new Set<string>();
  const seenDynamicExceptions = new Set<string>();
  const seenSeededStageExceptions = new Set<string>();

  for (const owner of config.mutationOwners) {
    const key = ownerKey(owner.path, owner.functionName, owner.table, owner.operation);
    if (seenOwners.has(key)) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: `Transition owner ${owner.functionName} declares ${owner.operation} ${owner.table} more than once.`,
        path: owner.path,
      });
    }
    seenOwners.add(key);
    if (
      !owner.path.trim() ||
      !owner.functionName.trim() ||
      !owner.canonicalApi.trim() ||
      owner.callers.length === 0
    ) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: "Every transition owner needs a path, function, canonical API, and caller.",
        path: owner.path || "<config>",
      });
    }
  }

  for (const permission of config.importPermissions) {
    if (seenImports.has(permission.name)) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: `Transition import ${permission.name} is declared more than once.`,
        path: config.transitionModule,
      });
    }
    seenImports.add(permission.name);
    if (!permission.name.trim() || permission.callers.length === 0) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: "Every transition import permission needs a name and at least one caller.",
        path: config.transitionModule,
      });
    }
  }

  for (const owner of config.sqlFileOwners) {
    if (seenSqlFiles.has(owner.path)) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: `SQL owner path ${owner.path} is declared more than once.`,
        path: owner.path,
      });
    }
    seenSqlFiles.add(owner.path);
    if (!owner.owner.trim() || !owner.reason.trim()) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message: "Every SQL lifecycle owner needs a non-empty owner and reason.",
        path: owner.path,
      });
    }
  }

  for (const exception of config.dynamicTableExceptions) {
    const key = `${exception.path}\0${exception.functionName}`;
    if (seenDynamicExceptions.has(key) || !exception.owner.trim() || !exception.reason.trim()) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message:
          "Dynamic-table exceptions must be unique and include a non-empty owner and reason.",
        path: exception.path,
      });
    }
    seenDynamicExceptions.add(key);
  }

  for (const exception of config.seededStageLiteralExceptions) {
    const key = `${exception.path}\0${exception.functionName}\0${exception.value}`;
    if (
      seenSeededStageExceptions.has(key) ||
      !exception.owner.trim() ||
      !exception.reason.trim() ||
      !config.seededStageSlugs.includes(exception.value)
    ) {
      diagnostics.push({
        code: "invalid-config",
        line: 1,
        message:
          "Seeded-stage literal exceptions must be unique, target a seeded slug, and include a non-empty owner and reason.",
        path: exception.path,
      });
    }
    seenSeededStageExceptions.add(key);
  }

  return diagnostics;
}

function sqlTouchesProtectedLifecycle(source: string, protectedTables: readonly PipelineTable[]) {
  const normalized = source.toLowerCase();
  const mentionsTable = protectedTables.some((table) =>
    new RegExp(`\\b(?:public\\.)?${table}\\b`, "i").test(normalized),
  );
  return mentionsTable && /\b(?:delete|execute|insert|merge|update)\b/i.test(normalized);
}

type SqlFunctionDefinition = Readonly<{
  name: string;
  source: string;
  start: number;
}>;

function sqlFunctionDefinitions(source: string): SqlFunctionDefinition[] {
  const pattern =
    /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  const headers = [...source.matchAll(pattern)];
  return headers.map((header, index) => {
    const start = header.index;
    const nextStart = headers[index + 1]?.index ?? source.length;
    const candidate = source.slice(start, nextStart);
    const bodyStartMatch = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(candidate);
    let end = nextStart;
    if (bodyStartMatch?.index !== undefined) {
      const delimiter = bodyStartMatch[1]!;
      const bodyStart = bodyStartMatch.index + bodyStartMatch[0].length;
      const closingDelimiter = candidate.indexOf(delimiter, bodyStart);
      if (closingDelimiter >= 0) {
        end = start + closingDelimiter + delimiter.length;
      }
    }
    return {
      name: header[1]!.toLowerCase(),
      source: source.slice(start, end),
      start,
    };
  });
}

function sqlStringLiterals(source: string) {
  const literals: Array<{ index: number; value: string }> = [];
  const pattern = /'((?:''|[^'])*)'/g;
  for (const match of source.matchAll(pattern)) {
    literals.push({
      index: match.index,
      value: match[1]!.replaceAll("''", "'"),
    });
  }
  return literals;
}

function isTransitionModuleSpecifier(specifier: string, configuredSpecifier: string) {
  return (
    specifier === configuredSpecifier ||
    specifier === "./transitions" ||
    specifier.endsWith("/pipeline/transitions")
  );
}

export function verifyPipelineTransitions({
  config,
  files,
}: VerifyInput): PipelineTransitionDiagnostic[] {
  const diagnostics = invalidConfigDiagnostics(config);
  if (diagnostics.length > 0) return diagnostics;

  const protectedTables = new Set(config.protectedTables);
  const ownerByKey = new Map(
    config.mutationOwners.map((owner) => [
      ownerKey(owner.path, owner.functionName, owner.table, owner.operation),
      owner,
    ]),
  );
  const recoveryReadByKey = new Map(
    config.recoveryReadOwners.map((owner) => [
      ownerKey(owner.path, owner.functionName, owner.table, "select"),
      owner,
    ]),
  );
  const importPermissionByName = new Map(
    config.importPermissions.map((permission) => [permission.name, permission]),
  );
  const rpcOwnerByName = new Map(config.rpcOwners.map((owner) => [owner.rpc, owner]));
  const dynamicExceptionByKey = new Map(
    config.dynamicTableExceptions.map((exception) => [
      `${exception.path}\0${exception.functionName}`,
      exception,
    ]),
  );
  const sqlOwnerByPath = new Map(config.sqlFileOwners.map((owner) => [owner.path, owner]));
  const usedOwners = new Set<string>();
  const usedRecoveryReads = new Set<string>();
  const usedImports = new Set<string>();
  const usedDynamicExceptions = new Set<string>();
  const usedSeededStageExceptions = new Set<string>();
  const usedSqlOwners = new Set<string>();
  const latestRpcDefinition = new Map<string, string>();

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!isWithin(file.path, config.sourceRoots)) continue;
    if (file.path.endsWith(".sql")) {
      if (sqlTouchesProtectedLifecycle(file.source, config.protectedTables)) {
        const owner = sqlOwnerByPath.get(file.path);
        if (owner) {
          usedSqlOwners.add(file.path);
        } else {
          diagnostics.push({
            code: "sql-owner",
            line: 1,
            message:
              "SQL touches protected pipeline lifecycle tables outside the exact migration allowlist. Use a named transactional RPC and register its owning migration in pipelineTransitionBoundaryConfig.",
            path: file.path,
          });
        }
      }
      for (const definition of sqlFunctionDefinitions(file.source)) {
        if (rpcOwnerByName.has(definition.name)) {
          latestRpcDefinition.set(definition.name, file.path);
        }
        for (const literal of sqlStringLiterals(definition.source)) {
          if (!config.seededStageSlugs.includes(literal.value)) continue;
          const exceptionKey = `${file.path}\0${definition.name}\0${literal.value}`;
          const exception = config.seededStageLiteralExceptions.find(
            (candidate) =>
              candidate.path === file.path &&
              candidate.functionName === definition.name &&
              candidate.value === literal.value,
          );
          if (exception) {
            usedSeededStageExceptions.add(exceptionKey);
          } else {
            diagnostics.push({
              code: "seeded-stage-branch",
              line: file.source.slice(0, definition.start + literal.index).split("\n").length,
              message:
                "Generic pipeline SQL functions cannot name a seeded stage slug. Resolve stages by id/position; seeded defaults belong in an exact designated adapter.",
              path: file.path,
            });
          }
        }
      }
      continue;
    }

    if (TEST_FILE_PATTERN.test(file.path)) continue;
    const sourceFile = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const importLocalNames = new Map<string, string>();

    function visit(node: ts.Node) {
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isTransitionModuleSpecifier(node.moduleSpecifier.text, config.transitionModule)
      ) {
        diagnostics.push({
          code: "unauthorized-transition-import",
          line: lineOf(sourceFile, node),
          message:
            "Pipeline transition APIs cannot be re-exported; callers must import their exact owned API directly.",
          path: file.path,
        });
        return;
      }

      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isTransitionModuleSpecifier(node.moduleSpecifier.text, config.transitionModule)
      ) {
        const clause = node.importClause;
        if (!clause || clause.isTypeOnly || !clause.namedBindings) return;
        if (!ts.isNamedImports(clause.namedBindings)) {
          diagnostics.push({
            code: "unauthorized-transition-import",
            line: lineOf(sourceFile, node),
            message:
              "Pipeline transition owners must be imported by exact named API; namespace imports can bypass the caller allowlist.",
            path: file.path,
          });
          return;
        }
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          const permission = importPermissionByName.get(importedName);
          if (!permission || !permission.callers.includes(file.path)) {
            diagnostics.push({
              code: "unauthorized-transition-import",
              line: lineOf(sourceFile, element),
              message: `Only the exact callers declared for ${importedName} may import that transition. Use the canonical transition API from its owned boundary.`,
              path: file.path,
            });
            continue;
          }
          importLocalNames.set(element.name.text, importedName);
          usedImports.add(callerKey(importedName, file.path));
        }
        return;
      }

      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (
          config.seededStageSlugs.includes(node.text) &&
          isWithin(file.path, config.genericStageSourceRoots) &&
          !isWithin(file.path, config.seededStageAdapters)
        ) {
          const functionName = enclosingFunctionName(node) ?? "<module>";
          const exceptionKey = `${file.path}\0${functionName}\0${node.text}`;
          const exception = config.seededStageLiteralExceptions.find(
            (candidate) =>
              candidate.path === file.path &&
              candidate.functionName === functionName &&
              candidate.value === node.text,
          );
          if (exception) {
            usedSeededStageExceptions.add(exceptionKey);
          } else {
            diagnostics.push({
              code: "seeded-stage-branch",
              line: lineOf(sourceFile, node),
              message:
                "Generic pipeline production code cannot name a seeded stage slug. Resolve stages by id/position; seeded defaults belong in a designated adapter.",
              path: file.path,
            });
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const method = propertyName(node.expression);
        const receiver = propertyReceiver(node.expression);

        const isDynamicModuleLoad =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require");
        if (node.arguments[0] && isDynamicModuleLoad) {
          if (
            !ts.isStringLiteralLike(node.arguments[0]) ||
            isTransitionModuleSpecifier(node.arguments[0].text, config.transitionModule)
          ) {
            diagnostics.push({
              code: "unauthorized-transition-import",
              line: lineOf(sourceFile, node),
              message:
                "Computed module loads and dynamic transition imports are fail-closed; pipeline callers must use an exact static named import.",
              path: file.path,
            });
          }
        }

        if (method === "from" && receiver) {
          const tableArgument = node.arguments[0];
          const receiverText = receiver.getText(sourceFile);
          if (
            !tableArgument ||
            (!ts.isStringLiteralLike(tableArgument) &&
              !ts.isNoSubstitutionTemplateLiteral(tableArgument))
          ) {
            if (
              !receiverText.endsWith(".storage") &&
              !["Array", "Buffer", "Readable"].includes(receiverText)
            ) {
              const functionName = enclosingFunctionName(node) ?? "<module>";
              const key = `${file.path}\0${functionName}`;
              const exception = dynamicExceptionByKey.get(key);
              if (exception) {
                usedDynamicExceptions.add(key);
              } else {
                diagnostics.push({
                  code: "dynamic-table-access",
                  line: lineOf(sourceFile, node),
                  message:
                    "Dynamic database table access is fail-closed because it can hide protected lifecycle writes. Use a literal table through the canonical transition API.",
                  path: file.path,
                });
              }
            }
          } else if (protectedTables.has(tableArgument.text as PipelineTable)) {
            const table = tableArgument.text as PipelineTable;
            const operation = directOperation(node);
            const functionName = enclosingFunctionName(node) ?? "<module>";
            if (!operation) {
              diagnostics.push({
                code: "unbound-table-access",
                line: lineOf(sourceFile, node),
                message: `Protected ${table} handles cannot be aliased or detached. Perform a direct read or use the canonical transition API.`,
                path: file.path,
              });
            } else if (operation === "select") {
              const recoveryKey = ownerKey(file.path, functionName, table, operation);
              if (recoveryReadByKey.has(recoveryKey)) usedRecoveryReads.add(recoveryKey);
            } else if (MUTATION_OPERATIONS.has(operation)) {
              const key = ownerKey(file.path, functionName, table, operation);
              const owner = ownerByKey.get(key);
              if (owner) {
                usedOwners.add(key);
              } else {
                diagnostics.push({
                  code: "pipeline-owner",
                  line: lineOf(sourceFile, node),
                  message: `Direct ${operation} of protected ${table} is not owned by a named transition. Use the canonical API in ${config.transitionModule}.`,
                  path: file.path,
                });
              }
            }
          }
        }

        if (method === "rpc" && node.arguments[0]) {
          if (!ts.isStringLiteralLike(node.arguments[0])) {
            diagnostics.push({
              code: "dynamic-rpc-access",
              line: lineOf(sourceFile, node),
              message:
                "Dynamic RPC access is fail-closed because it can hide a protected lifecycle transition. Use a literal RPC name through its exact typed owner.",
              path: file.path,
            });
          } else if (rpcOwnerByName.has(node.arguments[0].text)) {
            const rpc = node.arguments[0].text;
            const owner = rpcOwnerByName.get(rpc)!;
            const functionName = enclosingFunctionName(node) ?? "<module>";
            if (file.path === owner.path && functionName === owner.functionName) {
              usedOwners.add(`rpc\0${rpc}`);
            } else {
              diagnostics.push({
                code: "pipeline-owner",
                line: lineOf(sourceFile, node),
                message: `Transactional RPC ${rpc} may only be called by ${owner.functionName}. ${owner.canonicalApi}`,
                path: file.path,
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    for (const statement of sourceFile.statements) {
      let reexportedTransition: string | undefined;
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text;
          reexportedTransition = importLocalNames.get(localName);
          if (reexportedTransition) break;
        }
      } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        reexportedTransition = importLocalNames.get(statement.expression.text);
      } else if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer && ts.isIdentifier(declaration.initializer)) {
            reexportedTransition = importLocalNames.get(declaration.initializer.text);
            if (reexportedTransition) break;
          }
        }
      }
      if (reexportedTransition) {
        diagnostics.push({
          code: "unauthorized-transition-import",
          line: lineOf(sourceFile, statement),
          message: `Imported transition ${reexportedTransition} cannot be re-exported or aliased through an exported binding; callers must import their exact owned API directly.`,
          path: file.path,
        });
      }
    }

    for (const [localName, importedName] of importLocalNames) {
      let references = 0;
      function countReferences(node: ts.Node) {
        if (
          ts.isIdentifier(node) &&
          node.text === localName &&
          !(
            ts.isImportSpecifier(node.parent) ||
            (ts.isImportSpecifier(node.parent.parent) && node.parent.parent.name === node)
          )
        ) {
          references++;
        }
        ts.forEachChild(node, countReferences);
      }
      countReferences(sourceFile);
      if (references === 0) {
        diagnostics.push({
          code: "unused-owner",
          line: 1,
          message: `Imported transition ${importedName} is unused; remove the stale permission or restore its canonical call path.`,
          path: file.path,
        });
      }
    }
  }

  for (const owner of config.mutationOwners) {
    const key = ownerKey(owner.path, owner.functionName, owner.table, owner.operation);
    if (!usedOwners.has(key)) {
      diagnostics.push({
        code: owner.recovery ? "recovery-owner-unused" : "unused-owner",
        line: 1,
        message: `${owner.recovery ?? "ordinary"} transition ${owner.functionName} no longer owns ${owner.operation} ${owner.table}; remove the stale allowlist entry or restore the canonical transition.`,
        path: owner.path,
      });
    }
  }

  for (const owner of config.recoveryReadOwners) {
    const key = ownerKey(owner.path, owner.functionName, owner.table, "select");
    if (!usedRecoveryReads.has(key)) {
      diagnostics.push({
        code: "recovery-owner-unused",
        line: 1,
        message: `${owner.category} recovery owner ${owner.functionName} no longer reads ${owner.table}; remove the stale exception or restore the owned recovery path.`,
        path: owner.path,
      });
    }
  }

  for (const permission of config.importPermissions) {
    for (const caller of permission.callers) {
      if (!usedImports.has(callerKey(permission.name, caller))) {
        diagnostics.push({
          code: "unused-owner",
          line: 1,
          message: `${caller} no longer imports transition ${permission.name}; remove the stale caller permission or restore the canonical call path.`,
          path: caller,
        });
      }
    }
  }

  for (const owner of config.rpcOwners) {
    if (!usedOwners.has(`rpc\0${owner.rpc}`)) {
      diagnostics.push({
        code: "unused-owner",
        line: 1,
        message: `Transactional RPC wrapper ${owner.functionName} no longer calls ${owner.rpc}. ${owner.canonicalApi}`,
        path: owner.path,
      });
    }
    const latest = latestRpcDefinition.get(owner.rpc);
    if (latest !== owner.latestMigration) {
      diagnostics.push({
        code: "sql-owner",
        line: 1,
        message: `The effective ${owner.rpc} definition is ${latest ?? "missing"}, not its exact owner ${owner.latestMigration}. ${owner.canonicalApi}`,
        path: latest ?? owner.latestMigration,
      });
    }
  }

  for (const [key, exception] of dynamicExceptionByKey) {
    if (!usedDynamicExceptions.has(key)) {
      diagnostics.push({
        code: "unused-owner",
        line: 1,
        message: `Dynamic-table exception owned by ${exception.owner} is unused: ${exception.reason}`,
        path: exception.path,
      });
    }
  }

  for (const owner of config.sqlFileOwners) {
    if (!usedSqlOwners.has(owner.path)) {
      diagnostics.push({
        code: "unused-owner",
        line: 1,
        message: `SQL lifecycle allowlist entry owned by ${owner.owner} is unused: ${owner.reason}`,
        path: owner.path,
      });
    }
  }

  for (const exception of config.seededStageLiteralExceptions) {
    const key = `${exception.path}\0${exception.functionName}\0${exception.value}`;
    if (!usedSeededStageExceptions.has(key)) {
      diagnostics.push({
        code: "unused-owner",
        line: 1,
        message: `Seeded-stage literal exception owned by ${exception.owner} is unused: ${exception.reason}`,
        path: exception.path,
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

export function formatPipelineTransitionDiagnostics(
  diagnostics: readonly PipelineTransitionDiagnostic[],
) {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.path}:${diagnostic.line} [${diagnostic.code}] ${diagnostic.message}`,
    )
    .join("\n");
}

function main() {
  const diagnostics = verifyPipelineTransitions({
    config: pipelineTransitionBoundaryConfig,
    files: loadPipelineTransitionFiles(),
  });
  if (diagnostics.length === 0) return;
  console.error(formatPipelineTransitionDiagnostics(diagnostics));
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
