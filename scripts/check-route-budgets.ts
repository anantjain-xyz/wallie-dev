import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const establishedMaximumBytes = {
  "shared/root": 450 * 1024,
  pipeline: 750 * 1024,
  sessions: 750 * 1024,
  settings: 850 * 1024,
  detail: 900 * 1024,
  onboarding: 675 * 1024,
} as const;

export type BudgetName = keyof typeof establishedMaximumBytes;
export type RouteBudgetConfig = Record<BudgetName, number>;

export type RouteBundleStat = Readonly<{
  firstLoadChunkPaths: string[];
  firstLoadUncompressedJsBytes: number;
  route: string;
}>;

const routeByBudget: Record<Exclude<BudgetName, "shared/root">, string> = {
  pipeline: "/w/[workspaceSlug]",
  sessions: "/w/[workspaceSlug]/sessions",
  settings: "/w/[workspaceSlug]/settings",
  detail: "/w/[workspaceSlug]/sessions/[sessionNumber]",
  onboarding: "/w/[workspaceSlug]/onboarding",
};

export function parseRouteBundleStats(json: string): RouteBundleStat[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("Route bundle stats must be an array.");

  const routes = new Set<string>();
  return value.map((row, index) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("route" in row) ||
      typeof row.route !== "string" ||
      !("firstLoadUncompressedJsBytes" in row) ||
      typeof row.firstLoadUncompressedJsBytes !== "number" ||
      !Number.isSafeInteger(row.firstLoadUncompressedJsBytes) ||
      row.firstLoadUncompressedJsBytes < 0 ||
      !("firstLoadChunkPaths" in row) ||
      !Array.isArray(row.firstLoadChunkPaths) ||
      !row.firstLoadChunkPaths.every((path: unknown) => typeof path === "string")
    ) {
      throw new Error(`Invalid route bundle stat at index ${index}.`);
    }
    if (routes.has(row.route)) throw new Error(`Duplicate route bundle stat: ${row.route}`);
    routes.add(row.route);
    return {
      firstLoadChunkPaths: row.firstLoadChunkPaths,
      firstLoadUncompressedJsBytes: row.firstLoadUncompressedJsBytes,
      route: row.route,
    };
  });
}

export function parseBudgetConfig(json: string): RouteBudgetConfig {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Route budget config must be an object.");
  }

  const config = value as Record<string, unknown>;
  const expectedNames = Object.keys(establishedMaximumBytes) as BudgetName[];
  const unexpected = Object.keys(config).filter(
    (name) => !expectedNames.includes(name as BudgetName),
  );
  if (unexpected.length > 0) throw new Error(`Unknown route budgets: ${unexpected.join(", ")}`);

  return Object.fromEntries(
    expectedNames.map((name) => {
      const bytes = config[name];
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new Error(`Budget ${name} must be a positive integer byte count.`);
      }
      if (bytes > establishedMaximumBytes[name]) {
        throw new Error(
          `Budget ${name} increased above its established ceiling (${bytes} > ${establishedMaximumBytes[name]} bytes).`,
        );
      }
      return [name, bytes];
    }),
  ) as RouteBudgetConfig;
}

export function sharedRootBytes(projectDirectory: string) {
  const manifest = JSON.parse(
    readFileSync(resolve(projectDirectory, ".next/build-manifest.json"), "utf8"),
  ) as { rootMainFiles?: unknown };
  if (
    !Array.isArray(manifest.rootMainFiles) ||
    !manifest.rootMainFiles.every((x) => typeof x === "string")
  ) {
    throw new Error("Next build manifest is missing rootMainFiles.");
  }
  return manifest.rootMainFiles
    .filter((path) => path.endsWith(".js"))
    .reduce((total, path) => total + statSync(resolve(projectDirectory, ".next", path)).size, 0);
}

export function evaluateRouteBudgets(input: {
  budgets: RouteBudgetConfig;
  sharedRootBytes: number;
  stats: RouteBundleStat[];
}) {
  const statByRoute = new Map(input.stats.map((stat) => [stat.route, stat]));
  return (Object.keys(input.budgets) as BudgetName[]).map((name) => {
    const route = name === "shared/root" ? null : routeByBudget[name];
    const routeTotalBytes = route ? statByRoute.get(route)?.firstLoadUncompressedJsBytes : null;
    if (routeTotalBytes === undefined) {
      throw new Error(`Missing route bundle stat for ${route}.`);
    }
    const currentBytes =
      routeTotalBytes === null ? input.sharedRootBytes : routeTotalBytes - input.sharedRootBytes;
    const budgetBytes = input.budgets[name];
    return {
      budgetBytes,
      currentBytes,
      name,
      overBudgetBytes: Math.max(0, currentBytes - budgetBytes),
      route,
      routeTotalBytes,
    };
  });
}

function parseArgs(args: string[]) {
  const options = {
    budgets: "config/route-budgets.json",
    rootBytes: undefined as number | undefined,
    stats: ".next/diagnostics/route-bundle-stats.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--budgets") options.budgets = value;
    else if (flag === "--stats") options.stats = value;
    else if (flag === "--root-bytes") options.rootBytes = Number(value);
    else throw new Error(`Unknown option: ${flag}`);
    index += 1;
  }
  return options;
}

export function runRouteBudgetCheck(
  args = process.argv.slice(2),
  projectDirectory = process.cwd(),
) {
  const options = parseArgs(args);
  const budgets = parseBudgetConfig(
    readFileSync(resolve(projectDirectory, options.budgets), "utf8"),
  );
  const stats = parseRouteBundleStats(
    readFileSync(resolve(projectDirectory, options.stats), "utf8"),
  );
  const results = evaluateRouteBudgets({
    budgets,
    sharedRootBytes: options.rootBytes ?? sharedRootBytes(projectDirectory),
    stats,
  });

  for (const result of results) {
    const status = result.overBudgetBytes === 0 ? "PASS" : "OVER";
    console.log(
      `${status} ${result.name}: current=${result.currentBytes} budget=${result.budgetBytes} bytes${
        result.route ? ` total=${result.routeTotalBytes} route=${result.route}` : ""
      }`,
    );
  }

  const violations = results.filter((result) => result.overBudgetBytes > 0);
  if (violations.length > 0) {
    console.error(
      `Route bundle budget failed: ${violations.map((result) => `${result.name} +${result.overBudgetBytes}`).join(", ")} bytes.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runRouteBudgetCheck();
}
