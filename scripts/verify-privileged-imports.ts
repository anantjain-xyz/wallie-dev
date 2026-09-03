// Privileged-import lint: a direct-import restriction plus a
// browser-reachability check. Unapproved modules that import admin, server
// env, or crypto directly are flagged; privileged modules reachable from
// configured browser entry points are flagged. Transitive reachability from
// an ordinary server module through a `server-only` service is not.
//
// Approved owners are the worker (src/worker), any route handler
// (src/app files named route.ts), and any module that imports "server-only".
// The check does not distinguish, within server code, between routes that
// need service-role and routes that could use the RLS client.
import { resolveModuleName } from "typescript";
import ts from "typescript";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { privilegedImportBoundaryConfig } from "./privileged-import-boundaries.config";

export type PrivilegedImportDiagnosticCode =
  | "client-reachability"
  | "invalid-config"
  | "missing-server-only-boundary"
  | "unapproved-owner"
  | "unused-exception";

export type PrivilegedImportException = Readonly<{
  code: Extract<PrivilegedImportDiagnosticCode, "client-reachability" | "unapproved-owner">;
  from: string;
  owner: string;
  reason: string;
  to: string;
}>;

export type PrivilegedOwnerRule = Readonly<{
  boundary: "next-route" | "server-only-import" | "worker-runtime";
  description: string;
  exactPaths?: readonly string[];
  id: string;
  pathPrefix?: string;
  pathSuffix?: string;
}>;

export type PrivilegedModule = Readonly<{
  approvedOwnerIds: readonly string[];
  description: string;
  path: string;
  requiresServerOnlyImport: boolean;
}>;

export type PrivilegedImportBoundaryConfig = Readonly<{
  browserEntryPoints: readonly string[];
  exceptions: readonly PrivilegedImportException[];
  ownerRules: readonly PrivilegedOwnerRule[];
  privilegedModules: readonly PrivilegedModule[];
  sourceRoots: readonly string[];
}>;

export type PrivilegedImportDiagnostic = Readonly<{
  approvedOwners?: readonly string[];
  code: PrivilegedImportDiagnosticCode;
  from?: string;
  line?: number;
  message: string;
  to?: string;
}>;

type ImportEdge = Readonly<{
  from: string;
  isTypeOnly: boolean;
  line: number;
  specifier: string;
  to: string;
}>;

type ModuleRecord = Readonly<{
  edges: readonly ImportEdge[];
  importsServerOnly: boolean;
  path: string;
  useClient: boolean;
}>;

type VerificationInput = Readonly<{
  config: PrivilegedImportBoundaryConfig;
  projectRoot?: string;
  tsconfigPath?: string;
}>;

const excludedProductionFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function normalizePath(path: string) {
  return path.split(sep).join("/");
}

function projectPath(projectRoot: string, path: string) {
  return normalizePath(relative(projectRoot, path));
}

function isInSourceRoots(path: string, sourceRoots: readonly string[]) {
  return sourceRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

function readProgram(tsconfigPath: string) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    resolve(tsconfigPath, ".."),
    undefined,
    tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    );
  }

  return ts.createProgram({
    options: parsed.options,
    rootNames: parsed.fileNames,
  });
}

function hasUseClientDirective(sourceFile: ts.SourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  return (
    clause.name === undefined &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function resolveImport(
  specifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
) {
  const result = resolveModuleName(specifier, containingFile, compilerOptions, ts.sys);
  return result.resolvedModule ? resolve(result.resolvedModule.resolvedFileName) : null;
}

function collectModule(
  sourceFile: ts.SourceFile,
  relativePath: string,
  compilerOptions: ts.CompilerOptions,
  sourcePathByAbsolutePath: ReadonlyMap<string, string>,
): ModuleRecord {
  const edges: ImportEdge[] = [];
  let importsServerOnly = false;

  function addEdge(specifier: string, node: ts.Node, isTypeOnly: boolean) {
    if (specifier === "server-only" && !isTypeOnly) importsServerOnly = true;
    const resolvedPath = resolveImport(specifier, sourceFile.fileName, compilerOptions);
    if (!resolvedPath) return;
    const targetPath = sourcePathByAbsolutePath.get(resolvedPath);
    if (!targetPath) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    edges.push({
      from: relativePath,
      isTypeOnly,
      line: line + 1,
      specifier,
      to: targetPath,
    });
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addEdge(node.moduleSpecifier.text, node.moduleSpecifier, importDeclarationIsTypeOnly(node));
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addEdge(node.moduleSpecifier.text, node.moduleSpecifier, exportDeclarationIsTypeOnly(node));
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addEdge(
        node.moduleReference.expression.text,
        node.moduleReference.expression,
        node.isTypeOnly,
      );
      return;
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      addEdge(node.argument.literal.text, node.argument.literal, true);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addEdge(node.arguments[0].text, node.arguments[0], false);
        return;
      }
      if (
        node.arguments.length === 1 &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        addEdge(node.arguments[0].text, node.arguments[0], false);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    edges,
    importsServerOnly,
    path: relativePath,
    useClient: hasUseClientDirective(sourceFile),
  };
}

function ownerRuleMatches(rule: PrivilegedOwnerRule, module: ModuleRecord) {
  if (rule.exactPaths && !rule.exactPaths.includes(module.path)) return false;
  if (rule.pathPrefix && !module.path.startsWith(rule.pathPrefix)) return false;
  if (rule.pathSuffix && !module.path.endsWith(rule.pathSuffix)) return false;
  if (rule.boundary === "server-only-import" && !module.importsServerOnly) return false;
  return Boolean(
    rule.exactPaths || rule.pathPrefix || rule.pathSuffix || rule.boundary === "server-only-import",
  );
}

function approvedOwnerDescriptions(
  privilegedModule: PrivilegedModule,
  ownerRuleById: ReadonlyMap<string, PrivilegedOwnerRule>,
) {
  return privilegedModule.approvedOwnerIds.map(
    (id) => ownerRuleById.get(id)?.description ?? `<unknown owner ${id}>`,
  );
}

function exceptionMatches(
  exception: PrivilegedImportException,
  code: PrivilegedImportException["code"],
  from: string,
  to: string,
) {
  return exception.code === code && exception.from === from && exception.to === to;
}

function invalidConfigDiagnostics(
  config: PrivilegedImportBoundaryConfig,
  modules: ReadonlyMap<string, ModuleRecord>,
) {
  const diagnostics: PrivilegedImportDiagnostic[] = [];
  const ownerIds = new Set<string>();
  for (const rule of config.ownerRules) {
    if (!rule.id.trim() || !rule.description.trim()) {
      diagnostics.push({
        code: "invalid-config",
        message: "Every approved owner rule must include a non-empty id and description.",
      });
    }
    if (
      rule.boundary !== "server-only-import" &&
      !rule.exactPaths &&
      !rule.pathPrefix &&
      !rule.pathSuffix
    ) {
      diagnostics.push({
        code: "invalid-config",
        message: `Approved owner "${rule.id}" uses the ${rule.boundary} boundary without declaring which modules it owns.`,
      });
    }
    if (ownerIds.has(rule.id)) {
      diagnostics.push({
        code: "invalid-config",
        message: `Approved owner id "${rule.id}" is declared more than once.`,
      });
    }
    ownerIds.add(rule.id);
  }

  const privilegedPaths = new Set<string>();
  for (const privilegedModule of config.privilegedModules) {
    if (privilegedPaths.has(privilegedModule.path)) {
      diagnostics.push({
        code: "invalid-config",
        message: `Privileged module "${privilegedModule.path}" is declared more than once.`,
      });
    }
    privilegedPaths.add(privilegedModule.path);
    if (!modules.has(privilegedModule.path)) {
      diagnostics.push({
        code: "invalid-config",
        message: `Declared privileged module "${privilegedModule.path}" does not exist in the module graph.`,
      });
    }
    for (const ownerId of privilegedModule.approvedOwnerIds) {
      if (!ownerIds.has(ownerId)) {
        diagnostics.push({
          code: "invalid-config",
          message: `Privileged module "${privilegedModule.path}" names unknown approved owner "${ownerId}".`,
        });
      }
    }
  }

  for (const browserEntryPoint of config.browserEntryPoints) {
    if (!modules.has(browserEntryPoint)) {
      diagnostics.push({
        code: "invalid-config",
        message: `Declared browser entry point "${browserEntryPoint}" does not exist in the module graph.`,
      });
    }
  }

  const exceptionKeys = new Set<string>();
  for (const exception of config.exceptions) {
    if (!exception.owner.trim() || !exception.reason.trim()) {
      diagnostics.push({
        code: "invalid-config",
        from: exception.from,
        message: `Exception ${exception.code} ${exception.from} -> ${exception.to} must include a non-empty owner and reason.`,
        to: exception.to,
      });
    }
    const key = `${exception.code}\0${exception.from}\0${exception.to}`;
    if (exceptionKeys.has(key)) {
      diagnostics.push({
        code: "invalid-config",
        from: exception.from,
        message: `Exception ${exception.code} ${exception.from} -> ${exception.to} is declared more than once.`,
        to: exception.to,
      });
    }
    exceptionKeys.add(key);
  }
  return diagnostics;
}

function formatPath(edges: readonly ImportEdge[]) {
  if (edges.length === 0) return "";
  return [
    edges[0].from,
    ...edges.map((edge) => `${edge.to}${edge.isTypeOnly ? " (type-only)" : ""}`),
  ].join(" -> ");
}

export function verifyPrivilegedImports({
  config,
  projectRoot = process.cwd(),
  tsconfigPath = "tsconfig.json",
}: VerificationInput): PrivilegedImportDiagnostic[] {
  const absoluteRoot = resolve(projectRoot);
  const program = readProgram(
    isAbsolute(tsconfigPath) ? tsconfigPath : resolve(absoluteRoot, tsconfigPath),
  );
  const sourceFiles = program
    .getSourceFiles()
    .map((sourceFile) => ({
      path: projectPath(absoluteRoot, resolve(sourceFile.fileName)),
      sourceFile,
    }))
    .filter(
      ({ path, sourceFile }) =>
        !sourceFile.isDeclarationFile &&
        !path.startsWith("../") &&
        isInSourceRoots(path, config.sourceRoots) &&
        !excludedProductionFilePattern.test(path),
    );
  const sourcePathByAbsolutePath = new Map(
    sourceFiles.map(({ path, sourceFile }) => [resolve(sourceFile.fileName), path]),
  );
  const modules = new Map(
    sourceFiles.map(({ path, sourceFile }) => [
      path,
      collectModule(sourceFile, path, program.getCompilerOptions(), sourcePathByAbsolutePath),
    ]),
  );
  const diagnostics = invalidConfigDiagnostics(config, modules);
  const ownerRuleById = new Map(config.ownerRules.map((rule) => [rule.id, rule]));
  const privilegedModuleByPath = new Map(
    config.privilegedModules.map((privilegedModule) => [privilegedModule.path, privilegedModule]),
  );
  const consumedExceptions = new Set<number>();

  function consumeException(code: PrivilegedImportException["code"], from: string, to: string) {
    const index = config.exceptions.findIndex((exception) =>
      exceptionMatches(exception, code, from, to),
    );
    if (index === -1) return false;
    consumedExceptions.add(index);
    return true;
  }

  for (const privilegedModule of config.privilegedModules) {
    const moduleRecord = modules.get(privilegedModule.path);
    if (
      moduleRecord &&
      privilegedModule.requiresServerOnlyImport &&
      !moduleRecord.importsServerOnly
    ) {
      diagnostics.push({
        approvedOwners: approvedOwnerDescriptions(privilegedModule, ownerRuleById),
        code: "missing-server-only-boundary",
        from: privilegedModule.path,
        message: `${privilegedModule.description} "${privilegedModule.path}" must directly import "server-only".`,
      });
    }
  }

  for (const moduleRecord of modules.values()) {
    const matchingOwnerIds = new Set(
      config.ownerRules
        .filter((rule) => ownerRuleMatches(rule, moduleRecord))
        .map((rule) => rule.id),
    );
    for (const edge of moduleRecord.edges) {
      if (edge.isTypeOnly) continue;
      const privilegedModule = privilegedModuleByPath.get(edge.to);
      if (!privilegedModule) continue;
      const approved = privilegedModule.approvedOwnerIds.some((ownerId) =>
        matchingOwnerIds.has(ownerId),
      );
      if (approved || consumeException("unapproved-owner", edge.from, edge.to)) continue;
      const approvedOwners = approvedOwnerDescriptions(privilegedModule, ownerRuleById);
      diagnostics.push({
        approvedOwners,
        code: "unapproved-owner",
        from: edge.from,
        line: edge.line,
        message: `${edge.from}:${edge.line} has forbidden edge ${edge.from} -> ${edge.to} (${privilegedModule.description}). Approved owner(s): ${approvedOwners.join(", ")}.`,
        to: edge.to,
      });
    }
  }

  const browserRoots = new Set(config.browserEntryPoints);
  for (const moduleRecord of modules.values()) {
    if (moduleRecord.useClient) browserRoots.add(moduleRecord.path);
  }

  for (const browserRoot of browserRoots) {
    if (!modules.has(browserRoot)) continue;
    const pathsToVisit: ImportEdge[][] = [[]];
    const reportedEdges = new Set<string>();
    const visited = new Set([browserRoot]);
    while (pathsToVisit.length > 0) {
      const path = pathsToVisit.shift()!;
      const currentPath = path.at(-1)?.to ?? browserRoot;
      const current = modules.get(currentPath);
      if (!current) continue;
      for (const edge of current.edges) {
        if (edge.isTypeOnly) continue;
        const nextPath = [...path, edge];
        const privilegedModule = privilegedModuleByPath.get(edge.to);
        if (privilegedModule) {
          const edgeKey = `${edge.from}\0${edge.to}`;
          if (reportedEdges.has(edgeKey)) continue;
          reportedEdges.add(edgeKey);
          if (consumeException("client-reachability", edge.from, edge.to)) continue;
          const approvedOwners = approvedOwnerDescriptions(privilegedModule, ownerRuleById);
          diagnostics.push({
            approvedOwners,
            code: "client-reachability",
            from: edge.from,
            line: edge.line,
            message: `${browserRoot} reaches ${privilegedModule.description} through forbidden edge ${edge.from} -> ${edge.to}. Import path: ${formatPath(nextPath)}. Approved owner(s): ${approvedOwners.join(", ")}.`,
            to: edge.to,
          });
          continue;
        }
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          pathsToVisit.push(nextPath);
        }
      }
    }
  }

  config.exceptions.forEach((exception, index) => {
    if (consumedExceptions.has(index)) return;
    diagnostics.push({
      code: "unused-exception",
      from: exception.from,
      message: `Unused ${exception.code} exception ${exception.from} -> ${exception.to} (owner: ${exception.owner}; reason: ${exception.reason}). Remove stale exceptions when their forbidden edge is gone.`,
      to: exception.to,
    });
  });

  return diagnostics;
}

export function formatPrivilegedImportDiagnostics(
  diagnostics: readonly PrivilegedImportDiagnostic[],
) {
  return diagnostics.map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`).join("\n");
}

export function runPrivilegedImportCheck(
  projectRoot = process.cwd(),
  tsconfigPath = "tsconfig.json",
) {
  const diagnostics = verifyPrivilegedImports({
    config: privilegedImportBoundaryConfig,
    projectRoot,
    tsconfigPath,
  });
  if (diagnostics.length === 0) {
    console.log("Privileged import boundaries: PASS");
    return 0;
  }
  console.error(formatPrivilegedImportDiagnostics(diagnostics));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runPrivilegedImportCheck();
}
