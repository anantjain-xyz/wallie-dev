import type {
  RepositoryInferenceConfidence,
  RepositoryInferenceSource,
} from "@/lib/repo-inference/contracts";

export const REPOSITORY_INFERENCE_FILE_CANDIDATES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "turbo.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "playwright.config.js",
  "playwright.config.ts",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "uv.lock",
  "poetry.lock",
  "go.mod",
  "Cargo.toml",
  ".env.example",
  ".env.sample",
  "README.md",
] as const;

export type RepositoryInferenceFilePath = (typeof REPOSITORY_INFERENCE_FILE_CANDIDATES)[number];

export type RepositoryInferenceFile = {
  content: string | null;
  path: string;
};

export type InferredRepositoryProfile = {
  buildCommand: string | null;
  envKeySuggestions: string[];
  frameworkHints: string[];
  inferenceConfidence: RepositoryInferenceConfidence;
  inferenceSources: RepositoryInferenceSource[];
  installCommand: string | null;
  languageHints: string[];
  packageManager: string | null;
  setupNotes: string;
  testCommand: string | null;
};

type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
};

const packageManagerLockfileOrder = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["npm", "package-lock.json"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
] as const;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parsePackageJson(content: string | null): PackageJson | null {
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : null;
  } catch {
    return null;
  }
}

function packageJsonDependencyNames(packageJson: PackageJson | null): Set<string> {
  const names = new Set<string>();
  if (!packageJson) return names;

  for (const section of [packageJson.dependencies, packageJson.devDependencies]) {
    if (!section || typeof section !== "object") continue;
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }

  return names;
}

function normalizePackageManager(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.split("@")[0]?.trim().toLowerCase();
  return name || null;
}

function inferPackageManager(files: Map<string, string | null>, packageJson: PackageJson | null) {
  const explicit = normalizePackageManager(packageJson?.packageManager);
  if (explicit) return explicit;

  for (const [manager, path] of packageManagerLockfileOrder) {
    if (files.has(path)) return manager;
  }

  return packageJson ? "npm" : null;
}

function jsInstallCommand(packageManager: string | null) {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
      return "npm install";
    default:
      return null;
  }
}

function jsScriptCommand(packageManager: string | null, scriptName: "build" | "test") {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "npm":
      return scriptName === "test" ? "npm test" : "npm run build";
    default:
      return null;
  }
}

function hasScript(packageJson: PackageJson | null, scriptName: "build" | "test") {
  return typeof packageJson?.scripts?.[scriptName] === "string";
}

function inferEnvKeys(content: string | null): string[] {
  if (!content) return [];

  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match?.[1]) keys.push(match[1]);
  }

  return keys;
}

function hasText(content: string | null, pattern: RegExp) {
  return Boolean(content && pattern.test(content));
}

function confidenceFor(input: {
  languageHints: string[];
  packageManager: string | null;
  commands: Array<string | null>;
}): RepositoryInferenceConfidence {
  const hasLanguage = input.languageHints.length > 0;
  const hasCommand = input.commands.some(Boolean);

  if (input.packageManager && hasLanguage && hasCommand) return "high";
  if (input.packageManager || hasLanguage) return "medium";
  return "low";
}

export function inferRepositoryProfileFromFiles(
  inputFiles: readonly RepositoryInferenceFile[],
): InferredRepositoryProfile {
  const files = new Map(inputFiles.map((file) => [file.path, file.content]));
  const packageJson = parsePackageJson(files.get("package.json") ?? null);
  let packageManager = inferPackageManager(files, packageJson);
  const packageNames = packageJsonDependencyNames(packageJson);
  const languageHints: string[] = [];
  const frameworkHints: string[] = [];
  let installCommand: string | null = null;
  let buildCommand: string | null = null;
  let testCommand: string | null = null;

  if (packageJson) {
    languageHints.push("javascript");
    if (
      files.has("next.config.ts") ||
      files.has("vite.config.ts") ||
      files.has("playwright.config.ts") ||
      packageNames.has("typescript")
    ) {
      languageHints.push("typescript");
    }

    if (
      packageNames.has("next") ||
      files.has("next.config.js") ||
      files.has("next.config.mjs") ||
      files.has("next.config.ts")
    ) {
      frameworkHints.push("next");
    }
    if (packageNames.has("vite") || files.has("vite.config.js") || files.has("vite.config.ts")) {
      frameworkHints.push("vite");
    }
    if (
      packageNames.has("@playwright/test") ||
      files.has("playwright.config.js") ||
      files.has("playwright.config.ts")
    ) {
      frameworkHints.push("playwright");
    }
    if (packageNames.has("turbo") || files.has("turbo.json")) {
      frameworkHints.push("turbo");
    }

    installCommand = jsInstallCommand(packageManager);
    buildCommand = hasScript(packageJson, "build")
      ? jsScriptCommand(packageManager, "build")
      : null;
    testCommand = hasScript(packageJson, "test") ? jsScriptCommand(packageManager, "test") : null;
  }

  const pyproject = files.get("pyproject.toml") ?? null;
  const requirements = [
    files.get("requirements.txt") ?? null,
    files.get("requirements-dev.txt") ?? null,
  ].filter((content): content is string => content !== null);
  const hasPython = Boolean(
    pyproject || requirements.length || files.has("uv.lock") || files.has("poetry.lock"),
  );

  if (hasPython && languageHints.length === 0) {
    languageHints.push("python");
    if (files.has("uv.lock")) {
      packageManager = "uv";
      installCommand = "uv sync";
    } else if (files.has("poetry.lock")) {
      packageManager = "poetry";
      installCommand = "poetry install";
    } else if (files.has("requirements.txt")) {
      packageManager = "pip";
      installCommand = "pip install -r requirements.txt";
    }

    const pytestInRequirements = requirements.some((content) =>
      hasText(content, /(^|\n)\s*pytest(?:[<=>~! ]|$)/i),
    );
    const pytestInPyproject = hasText(pyproject, /pytest/i);
    testCommand = pytestInRequirements || pytestInPyproject ? "pytest" : null;
  }

  if (files.has("go.mod") && languageHints.length === 0) {
    languageHints.push("go");
    packageManager = "go";
    installCommand = "go mod download";
    testCommand = "go test ./...";
  }

  if (files.has("Cargo.toml") && languageHints.length === 0) {
    languageHints.push("rust");
    packageManager = "cargo";
    installCommand = "cargo fetch";
    testCommand = "cargo test";
  }

  const envKeySuggestions = unique([
    ...inferEnvKeys(files.get(".env.example") ?? null),
    ...inferEnvKeys(files.get(".env.sample") ?? null),
  ]);
  const inferenceSources = inputFiles.map((file) => ({
    path: file.path,
    reason: file.content === null ? "File exists" : "Read for static inference",
  }));
  const inferenceConfidence = confidenceFor({
    commands: [installCommand, buildCommand, testCommand],
    languageHints,
    packageManager,
  });

  return {
    buildCommand,
    envKeySuggestions,
    frameworkHints: unique(frameworkHints),
    inferenceConfidence,
    inferenceSources,
    installCommand,
    languageHints: unique(languageHints),
    packageManager,
    setupNotes: "",
    testCommand,
  };
}
