import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

type MarkdownNode = {
  children?: MarkdownNode[];
  depth?: number;
  identifier?: string;
  position?: {
    start: {
      line: number;
    };
  };
  type: string;
  url?: string;
  value?: string;
};

type MarkdownLink = {
  line: number;
  url: string;
};

type MarkdownDocument = {
  absolutePath: string;
  anchors: ReadonlySet<string>;
  definitions: ReadonlyMap<string, string>;
  links: readonly MarkdownLink[];
  relativePath: string;
  root: MarkdownNode;
};

export type DocumentationDiagnostic = Readonly<{
  document: string;
  invariant:
    | "declared-package-command"
    | "docs-index"
    | "markdown-anchor"
    | "markdown-reference"
    | "portable-path"
    | "repository-link"
    | "repository-path";
  line: number;
  message: string;
  repair: string;
}>;

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);
const repositoryPathPrefixes = [
  ".github/",
  "config/",
  "docs/",
  "e2e/",
  "public/",
  "scripts/",
  "src/",
  "supabase/",
  "test/",
] as const;
const repositoryRootConfigExtensions = new Set([
  "cjs",
  "json",
  "jsonc",
  "mjs",
  "toml",
  "ts",
  "yaml",
  "yml",
]);
const repositoryRootPathNames = new Set([
  ".env.example",
  "Dockerfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "middleware.ts",
  "package.json",
  "pnpm-lock.yaml",
  "railway.json",
  "skills-lock.json",
  "tsconfig.json",
]);
const pnpmBuiltInCommands = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "cat-file",
  "cat-index",
  "config",
  "create",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "fetch",
  "find-hash",
  "help",
  "i",
  "ignored-builds",
  "import",
  "init",
  "install",
  "install-test",
  "it",
  "link",
  "licenses",
  "list",
  "ln",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rb",
  "rebuild",
  "remove",
  "rm",
  "root",
  "run",
  "self-update",
  "server",
  "setup",
  "start",
  "store",
  "t",
  "test",
  "unlink",
  "up",
  "update",
  "why",
]);
const pnpmOptionsWithValues = new Set([
  "-C",
  "-F",
  "--cache-dir",
  "--config-dir",
  "--dir",
  "--fetch-retries",
  "--fetch-retry-factor",
  "--fetch-retry-maxtimeout",
  "--fetch-retry-mintimeout",
  "--fetch-timeout",
  "--filter",
  "--global-bin-dir",
  "--global-dir",
  "--loglevel",
  "--network-concurrency",
  "--package-import-method",
  "--reporter",
  "--state-dir",
  "--store-dir",
  "--use-node-version",
  "--virtual-store-dir",
  "--workspace-concurrency",
]);
const ignoredWalkDirectories = new Set([".git", ".next", "node_modules"]);

function normalizePath(path: string) {
  return path.split(sep).join("/");
}

function projectPath(projectDirectory: string, path: string) {
  return normalizePath(relative(projectDirectory, path));
}

function lineOf(node: MarkdownNode) {
  return node.position?.start.line ?? 1;
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function textOf(node: MarkdownNode): string {
  if (node.type === "html") return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function normalizedIdentifier(identifier: string) {
  return identifier.trim().toLowerCase().replace(/\s+/g, " ");
}

function headingSlug(value: string) {
  return Array.from(value.toLowerCase().trim())
    .filter((character) => /[\p{L}\p{N}\s_-]/u.test(character))
    .join("")
    .replace(/\s+/g, "-");
}

function collectAnchors(root: MarkdownNode) {
  const anchors = new Set<string>();
  const slugCounts = new Map<string, number>();

  visit(root, (node) => {
    if (node.type === "heading") {
      const baseSlug = headingSlug(textOf(node));
      const count = slugCounts.get(baseSlug) ?? 0;
      anchors.add(count === 0 ? baseSlug : `${baseSlug}-${count}`);
      slugCounts.set(baseSlug, count + 1);
    }

    if (
      node.type === "html" &&
      typeof node.value === "string" &&
      !node.value.trimStart().startsWith("<!--")
    ) {
      for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)) {
        if (match[1]) anchors.add(match[1]);
      }
    }
  });

  return anchors;
}

function collectDefinitions(root: MarkdownNode) {
  const definitions = new Map<string, string>();
  visit(root, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      const identifier = normalizedIdentifier(node.identifier);
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
  });
  return definitions;
}

function linksFromNode(
  node: MarkdownNode,
  definitions: ReadonlyMap<string, string>,
  includeImages = true,
): MarkdownLink[] {
  if (
    (node.type === "link" || (includeImages && node.type === "image")) &&
    typeof node.url === "string"
  ) {
    return [{ line: lineOf(node), url: node.url }];
  }
  if (
    (node.type === "linkReference" || (includeImages && node.type === "imageReference")) &&
    typeof node.identifier === "string"
  ) {
    const url = definitions.get(normalizedIdentifier(node.identifier));
    return url ? [{ line: lineOf(node), url }] : [];
  }
  if (node.type === "html" && typeof node.value === "string" && node.value.includes("<")) {
    const links: MarkdownLink[] = [];
    const html = node.value.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of html.matchAll(
      /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    )) {
      const isImage = match[4] !== undefined || match[5] !== undefined || match[6] !== undefined;
      if (isImage && !includeImages) continue;
      const url = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
      if (url !== undefined) links.push({ line: lineOf(node), url });
    }
    return links;
  }
  return [];
}

function collectLinks(root: MarkdownNode, definitions: ReadonlyMap<string, string>) {
  const links: MarkdownLink[] = [];
  visit(root, (node) => {
    links.push(...linksFromNode(node, definitions));
  });
  return links;
}

function unresolvedReferences(root: MarkdownNode, definitions: ReadonlyMap<string, string>) {
  const references: { identifier: string; line: number }[] = [];
  visit(root, (node) => {
    if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      typeof node.identifier === "string" &&
      !definitions.has(normalizedIdentifier(node.identifier))
    ) {
      references.push({ identifier: node.identifier, line: lineOf(node) });
    }
  });
  return references;
}

function taskMapNodes(root: MarkdownNode) {
  const children = root.children ?? [];
  const start = children.findIndex(
    (node) =>
      node.type === "heading" &&
      node.depth === 2 &&
      textOf(node).trim().toLowerCase() === "task map",
  );
  if (start === -1) return null;

  const nodes: MarkdownNode[] = [];
  for (const node of children.slice(start + 1)) {
    if (node.type === "heading" && (node.depth ?? 7) <= 2) break;
    nodes.push(node);
  }
  return nodes;
}

function isExternalDestination(destination: string) {
  return (
    /^[a-z][a-z+.-]*:/i.test(destination) ||
    destination.startsWith("//") ||
    destination.startsWith("/")
  );
}

function splitDestination(destination: string) {
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const encodedAnchor = hashIndex === -1 ? null : destination.slice(hashIndex + 1);

  try {
    return {
      anchor: encodedAnchor === null ? null : decodeURIComponent(encodedAnchor),
      path: decodeURIComponent(path),
    };
  } catch {
    return { anchor: encodedAnchor, path };
  }
}

function isInsideProject(projectDirectory: string, path: string) {
  const relativePath = relative(projectDirectory, path);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function machineLocalPaths(value: string) {
  const pattern =
    /(?:file:\/\/)?(?:\/Users\/[^/\s`"'<>]+(?:\/[^\s`"'<>)]*)?|\/home\/[^/\s`"'<>]+(?:\/[^\s`"'<>)]*)?|\/(?:private\/)?tmp\/[^\s`"'<>)]*|[A-Za-z]:[\\/]+Users[\\/][^\s`"'<>)]*)/g;
  return Array.from(value.matchAll(pattern), (match) => match[0]).filter((path) => {
    const portablePath = path.replace(/^file:\/\//, "");
    return !/^\/home\/(?:daytona|user|username)(?:\/|$)/.test(portablePath);
  });
}

function repositoryPathCandidate(value: string) {
  const candidate = value.trim().replace(/#.*$/, "");
  if (candidate.includes(" ")) return null;
  if (repositoryPathPrefixes.some((prefix) => candidate.startsWith(prefix))) return candidate;
  if (candidate.startsWith("./")) return candidate.slice(2);
  if (candidate.startsWith("../")) return candidate;
  if (repositoryRootPathNames.has(candidate)) return candidate;
  if (/^\.[A-Za-z0-9][A-Za-z0-9._-]*\.example$/.test(candidate)) return candidate;

  const configExtension = candidate.match(
    /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.config\.([A-Za-z0-9_-]+)$/,
  )?.[1];
  if (configExtension && repositoryRootConfigExtensions.has(configExtension.toLowerCase())) {
    return candidate;
  }
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.jsonc?$/.test(candidate) ? candidate : null;
}

function walkProjectPaths(projectDirectory: string) {
  const paths: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredWalkDirectories.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      paths.push(projectPath(projectDirectory, absolutePath));
      if (entry.isDirectory()) walk(absolutePath);
    }
  }

  walk(projectDirectory);
  return paths;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globPattern(pattern: string) {
  let expression = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    if (character === "{") {
      const closingBrace = pattern.indexOf("}", index + 1);
      if (closingBrace !== -1) {
        const alternatives = pattern
          .slice(index + 1, closingBrace)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        expression += `(?:${alternatives})`;
        index = closingBrace;
        continue;
      }
    }
    expression += escapeRegExp(character);
  }

  return new RegExp(`${expression}$`);
}

function repositoryPathExists(
  projectDirectory: string,
  candidate: string,
  allProjectPaths: () => readonly string[],
) {
  const normalizedCandidate = normalizePath(candidate).replace(/\/$/, "");
  if (/[*?{]/.test(normalizedCandidate)) {
    const pattern = globPattern(normalizedCandidate);
    return allProjectPaths().some((path) => pattern.test(path));
  }

  const absolutePath = resolve(projectDirectory, normalizedCandidate);
  return isInsideProject(projectDirectory, absolutePath) && existsSync(absolutePath);
}

function packageScripts(projectDirectory: string, diagnostics: DocumentationDiagnostic[]) {
  const packagePath = resolve(projectDirectory, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: unknown };
    if (
      typeof parsed.scripts === "object" &&
      parsed.scripts !== null &&
      !Array.isArray(parsed.scripts)
    ) {
      return new Set(Object.keys(parsed.scripts));
    }
  } catch {
    // The diagnostic below gives the stable repair for both unreadable and invalid JSON.
  }

  diagnostics.push({
    document: "package.json",
    invariant: "declared-package-command",
    line: 1,
    message: "package.json#scripts is unavailable, so documented pnpm commands cannot resolve.",
    repair: "Restore a valid package.json with a scripts object.",
  });
  return new Set<string>();
}

function shellWords(value: string) {
  return Array.from(
    value.matchAll(/"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+)/g),
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function commandAfterPnpmOptions(words: readonly string[], start = 0) {
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") return { command: words[index + 1], index: index + 1 };
    if (!word.startsWith("-") || word === "-") return { command: word, index };

    const optionName = word.split("=", 1)[0]!;
    const hasInlineValue =
      word.includes("=") || ((word.startsWith("-C") || word.startsWith("-F")) && word.length > 2);
    index += pnpmOptionsWithValues.has(optionName) && !hasInlineValue ? 2 : 1;
  }
  return { command: undefined, index };
}

function documentedPnpmCommands(value: string) {
  const commands: string[] = [];
  for (const match of value.matchAll(/\bpnpm\b([^;&|\n]*)/g)) {
    const words = shellWords(match[1] ?? "");
    const parsed = commandAfterPnpmOptions(words);
    const command = parsed.command;
    if (!command) continue;
    if (command === "run") {
      const script = commandAfterPnpmOptions(words, parsed.index + 1).command;
      commands.push(script ?? command);
    } else {
      commands.push(command);
    }
  }
  return commands;
}

export function verifyDocumentationContract(projectDirectory = process.cwd()) {
  const diagnostics: DocumentationDiagnostic[] = [];
  const docsDirectory = resolve(projectDirectory, "docs");
  let documentationPaths: string[];

  try {
    documentationPaths = readdirSync(docsDirectory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => resolve(docsDirectory, name))
      .filter((path) => statSync(path).isFile())
      .sort();
  } catch {
    return [
      {
        document: "docs/README.md",
        invariant: "docs-index",
        line: 1,
        message: "The top-level documentation directory or index cannot be read.",
        repair: "Restore docs/README.md and the top-level docs/*.md files.",
      },
    ] satisfies DocumentationDiagnostic[];
  }

  const documents = new Map<string, MarkdownDocument>();

  function readDocument(absolutePath: string) {
    const cached = documents.get(absolutePath);
    if (cached) return cached;

    try {
      const root = markdownProcessor.parse(
        readFileSync(absolutePath, "utf8"),
      ) as unknown as MarkdownNode;
      const definitions = collectDefinitions(root);
      const document = {
        absolutePath,
        anchors: collectAnchors(root),
        definitions,
        links: collectLinks(root, definitions),
        relativePath: projectPath(projectDirectory, absolutePath),
        root,
      } satisfies MarkdownDocument;
      documents.set(absolutePath, document);
      return document;
    } catch {
      diagnostics.push({
        document: projectPath(projectDirectory, absolutePath),
        invariant: "repository-link",
        line: 1,
        message: "The Markdown document cannot be read or parsed.",
        repair: "Restore a readable UTF-8 Markdown file.",
      });
      return null;
    }
  }

  for (const path of documentationPaths) readDocument(path);

  const indexPath = resolve(docsDirectory, "README.md");
  const indexDocument = readDocument(indexPath);
  const indexNodes = indexDocument ? taskMapNodes(indexDocument.root) : null;
  if (indexDocument && !indexNodes) {
    diagnostics.push({
      document: indexDocument.relativePath,
      invariant: "docs-index",
      line: 1,
      message: 'The documentation index has no "## Task map" section.',
      repair: 'Restore a "## Task map" section with one link to every top-level docs/*.md file.',
    });
  }

  if (indexDocument && indexNodes) {
    const indexLinks: MarkdownLink[] = [];
    for (const node of indexNodes) {
      visit(node, (child) => {
        indexLinks.push(...linksFromNode(child, indexDocument.definitions, false));
      });
    }

    for (const documentationPath of documentationPaths) {
      const count = indexLinks.filter((link) => {
        if (isExternalDestination(link.url)) return false;
        const { path } = splitDestination(link.url);
        return resolve(dirname(indexPath), path || ".") === documentationPath;
      }).length;
      const document = projectPath(projectDirectory, documentationPath);

      if (count === 0) {
        diagnostics.push({
          document: indexDocument.relativePath,
          invariant: "docs-index",
          line: 1,
          message: `${document} is not indexed in the Task map.`,
          repair: `Add exactly one Task map link to ${document}.`,
        });
      } else if (count > 1) {
        diagnostics.push({
          document: indexDocument.relativePath,
          invariant: "docs-index",
          line: 1,
          message: `${document} is indexed ${count} times in the Task map.`,
          repair: `Keep exactly one Task map link to ${document}.`,
        });
      }
    }
  }

  const scripts = packageScripts(projectDirectory, diagnostics);
  let cachedProjectPaths: readonly string[] | null = null;
  const allProjectPaths = () => {
    cachedProjectPaths ??= walkProjectPaths(projectDirectory);
    return cachedProjectPaths;
  };

  for (const documentationPath of documentationPaths) {
    const document = readDocument(documentationPath);
    if (!document) continue;

    for (const reference of unresolvedReferences(document.root, document.definitions)) {
      diagnostics.push({
        document: document.relativePath,
        invariant: "markdown-reference",
        line: reference.line,
        message: `Reference-style link "${reference.identifier}" has no definition.`,
        repair: `Add a [${reference.identifier}]: <repository-relative-target> definition or remove the reference.`,
      });
    }

    for (const link of document.links) {
      for (const localPath of machineLocalPaths(link.url)) {
        diagnostics.push({
          document: document.relativePath,
          invariant: "portable-path",
          line: link.line,
          message: `Link target "${localPath}" is a machine-local absolute path.`,
          repair: "Replace it with a repository-relative path or a portable placeholder.",
        });
      }

      if (isExternalDestination(link.url)) continue;
      const destination = splitDestination(link.url);
      const targetPath =
        destination.path === ""
          ? document.absolutePath
          : resolve(dirname(document.absolutePath), destination.path);
      if (!isInsideProject(projectDirectory, targetPath) || !existsSync(targetPath)) {
        diagnostics.push({
          document: document.relativePath,
          invariant: "repository-link",
          line: link.line,
          message: `Repository-relative link "${link.url}" does not resolve.`,
          repair: "Correct the target or restore the referenced repository path.",
        });
        continue;
      }

      if (destination.anchor !== null && destination.anchor !== "") {
        if (extname(targetPath).toLowerCase() !== ".md") {
          diagnostics.push({
            document: document.relativePath,
            invariant: "markdown-anchor",
            line: link.line,
            message: `Anchor "#${destination.anchor}" targets a non-Markdown path.`,
            repair: "Point the anchor at a Markdown heading or remove the fragment.",
          });
          continue;
        }
        const targetDocument = readDocument(targetPath);
        if (targetDocument && !targetDocument.anchors.has(destination.anchor)) {
          diagnostics.push({
            document: document.relativePath,
            invariant: "markdown-anchor",
            line: link.line,
            message: `Markdown anchor "#${destination.anchor}" does not exist in ${targetDocument.relativePath}.`,
            repair: "Use the target heading's generated anchor or restore that heading.",
          });
        }
      }
    }

    visit(document.root, (node) => {
      if (node.type === "text" || node.type === "inlineCode") {
        for (const localPath of machineLocalPaths(node.value ?? "")) {
          diagnostics.push({
            document: document.relativePath,
            invariant: "portable-path",
            line: lineOf(node),
            message: `Machine-local absolute path "${localPath}" is not portable.`,
            repair: "Replace it with a repository-relative path or a portable placeholder.",
          });
        }
      }

      if (node.type !== "inlineCode" || typeof node.value !== "string") return;

      const candidate = repositoryPathCandidate(node.value);
      if (candidate && !repositoryPathExists(projectDirectory, candidate, allProjectPaths)) {
        diagnostics.push({
          document: document.relativePath,
          invariant: "repository-path",
          line: lineOf(node),
          message: `Referenced code path "${candidate}" does not resolve.`,
          repair: "Correct the repository-relative code path or restore its owner.",
        });
      }

      for (const command of documentedPnpmCommands(node.value)) {
        if (pnpmBuiltInCommands.has(command) || scripts.has(command)) continue;
        diagnostics.push({
          document: document.relativePath,
          invariant: "declared-package-command",
          line: lineOf(node),
          message: `Documented package command "pnpm ${command}" is not declared in package.json#scripts.`,
          repair: `Declare the "${command}" script or update the documentation to a declared command.`,
        });
      }
    });
  }

  return diagnostics.sort(
    (left, right) =>
      left.document.localeCompare(right.document) ||
      left.line - right.line ||
      left.invariant.localeCompare(right.invariant) ||
      left.message.localeCompare(right.message),
  );
}

export function formatDocumentationDiagnostics(diagnostics: readonly DocumentationDiagnostic[]) {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.document}:${diagnostic.line} [${diagnostic.invariant}] ${diagnostic.message} Repair: ${diagnostic.repair}`,
    )
    .join("\n");
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const diagnostics = verifyDocumentationContract();
  if (diagnostics.length === 0) {
    console.log(
      "Documentation contract verified: the Task map, local links and anchors, code paths, package commands, and portable paths resolve.",
    );
  } else {
    console.error("Documentation contract violations:");
    console.error(formatDocumentationDiagnostics(diagnostics));
    process.exitCode = 1;
  }
}
