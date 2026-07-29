import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

type IgnoreOwner = "eslint" | "git" | "prettier";

type HygienePathPolicy = Readonly<{
  eslintPattern: string;
  gitIgnoreFile: ".gitignore" | "supabase/.gitignore";
  gitPattern: string;
  path: string;
  prettierPattern: string;
  protectedSimilarPath?: string;
  unsafePatterns?: Partial<Record<IgnoreOwner, readonly string[]>>;
}>;

type VerifyWorkspaceHygieneOptions = Readonly<{
  trackedPaths?: readonly string[];
}>;

const ownerFiles = {
  eslint: "eslint.config.mjs",
  git: ".gitignore",
  prettier: ".prettierignore",
} as const;

const hygienePathPolicies: readonly HygienePathPolicy[] = [
  rootToolOutput(".playwright-cli"),
  rootToolOutput(".playwright-mcp"),
  rootToolOutput(".pnpm-store"),
  rootToolOutput(".omo"),
  rootToolOutput("test-results"),
  rootToolOutput(".symphony/screenshots"),
  {
    eslintPattern: "supabase/.temp/**",
    gitIgnoreFile: "supabase/.gitignore",
    gitPattern: "/.temp/",
    path: "supabase/.temp/",
    prettierPattern: "/supabase/.temp/",
  },
  {
    eslintPattern: "src/app/preview/**",
    gitIgnoreFile: ".gitignore",
    gitPattern: "/src/app/preview/",
    path: "src/app/preview/",
    prettierPattern: "/src/app/preview/",
  },
];

function rootToolOutput(path: string): HygienePathPolicy {
  return {
    eslintPattern: `${path}/**`,
    gitIgnoreFile: ".gitignore",
    gitPattern: `/${path}/`,
    path: `${path}/`,
    prettierPattern: `/${path}/`,
    protectedSimilarPath: `src/lib/${path}/example.ts`,
    unsafePatterns: {
      eslint: [`**/${path}/**`],
      git: [path, `${path}/`, `**/${path}/**`],
      prettier: [path, `${path}/`, `**/${path}/**`],
    },
  };
}

function normalizePath(path: string) {
  return path.split(sep).join("/");
}

function readIgnorePatterns(path: string, errors: string[]) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
  } catch (error) {
    errors.push(`Could not parse ignore ownership from ${normalizePath(path)}: ${String(error)}`);
    return [];
  }
}

function readEslintGlobalIgnorePatterns(path: string, errors: string[]) {
  let sourceText: string;
  try {
    sourceText = readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`Could not parse ignore ownership from eslint.config.mjs: ${String(error)}`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const parseDiagnostics =
    (
      sourceFile as ts.SourceFile & {
        parseDiagnostics?: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    errors.push(
      `Could not parse ignore ownership from eslint.config.mjs: ${parseDiagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("; ")}`,
    );
    return [];
  }

  const patterns: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalIgnores"
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isArrayLiteralExpression(argument)) {
        for (const element of argument.elements) {
          if (ts.isStringLiteralLike(element)) patterns.push(element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return patterns;
}

function trackedRepositoryPaths(projectDirectory: string, errors: string[]) {
  try {
    return execFileSync("git", ["-C", projectDirectory, "ls-files", "--cached", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map(normalizePath);
  } catch (error) {
    errors.push(
      `.gitignore ownership could not inspect tracked repository paths: ${String(error)}`,
    );
    return [];
  }
}

function pathIsOwned(path: string, policyPath: string) {
  const directory = policyPath.endsWith("/") ? policyPath.slice(0, -1) : policyPath;
  return path === directory || path.startsWith(`${directory}/`);
}

function verifyOwnedPattern({
  errors,
  owner,
  ownerFile,
  patterns,
  policy,
  requiredPattern,
}: {
  errors: string[];
  owner: IgnoreOwner;
  ownerFile: string;
  patterns: readonly string[];
  policy: HygienePathPolicy;
  requiredPattern: string;
}) {
  if (!patterns.includes(requiredPattern)) {
    errors.push(
      `Workspace hygiene path "${policy.path}" is not owned by ${ownerFile}; add the bounded pattern "${requiredPattern}".`,
    );
  }

  for (const unsafePattern of policy.unsafePatterns?.[owner] ?? []) {
    if (patterns.includes(unsafePattern) && policy.protectedSimilarPath) {
      errors.push(
        `Legitimate source path "${policy.protectedSimilarPath}" is hidden by ${ownerFile} pattern "${unsafePattern}"; replace it with the bounded pattern "${requiredPattern}".`,
      );
    }
  }
}

export function verifyWorkspaceHygiene(
  projectDirectory = process.cwd(),
  options: VerifyWorkspaceHygieneOptions = {},
) {
  const errors: string[] = [];
  const gitPatternsByFile = new Map<string, readonly string[]>();
  for (const gitIgnoreFile of [".gitignore", "supabase/.gitignore"] as const) {
    gitPatternsByFile.set(
      gitIgnoreFile,
      readIgnorePatterns(resolve(projectDirectory, gitIgnoreFile), errors),
    );
  }
  const prettierPatterns = readIgnorePatterns(
    resolve(projectDirectory, ownerFiles.prettier),
    errors,
  );
  const eslintPatterns = readEslintGlobalIgnorePatterns(
    resolve(projectDirectory, ownerFiles.eslint),
    errors,
  );

  for (const policy of hygienePathPolicies) {
    verifyOwnedPattern({
      errors,
      owner: "git",
      ownerFile: policy.gitIgnoreFile,
      patterns: gitPatternsByFile.get(policy.gitIgnoreFile) ?? [],
      policy,
      requiredPattern: policy.gitPattern,
    });
    verifyOwnedPattern({
      errors,
      owner: "prettier",
      ownerFile: ownerFiles.prettier,
      patterns: prettierPatterns,
      policy,
      requiredPattern: policy.prettierPattern,
    });
    verifyOwnedPattern({
      errors,
      owner: "eslint",
      ownerFile: ownerFiles.eslint,
      patterns: eslintPatterns,
      policy,
      requiredPattern: policy.eslintPattern,
    });
  }

  const trackedPaths =
    options.trackedPaths === undefined
      ? trackedRepositoryPaths(projectDirectory, errors)
      : options.trackedPaths.map(normalizePath);
  for (const trackedPath of trackedPaths) {
    const policy = hygienePathPolicies.find(({ path }) => pathIsOwned(trackedPath, path));
    if (!policy) continue;
    errors.push(
      `Tracked workspace artifact "${trackedPath}" is prohibited; ${policy.gitIgnoreFile} owns it via "${policy.gitPattern}". Remove the path from Git's index.`,
    );
  }

  return errors;
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const errors = verifyWorkspaceHygiene();
  if (errors.length === 0) {
    console.log(
      "Workspace hygiene verified: Git, Prettier, and ESLint own bounded tool-output paths and no prohibited artifacts are tracked.",
    );
  } else {
    console.error("Workspace hygiene violations detected:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}
