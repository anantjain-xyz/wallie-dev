import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const generatedDatabaseTypesPath = "src/lib/supabase/database.types.ts";
export const supabaseMigrationsDirectory = "supabase/migrations";

export type DbTypesDriftResult = Readonly<{
  exitCode: number;
  latestMigration: string | null;
  messages: readonly string[];
}>;

const TYPE_CHANGING_SQL = [
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bCREATE\s+TYPE\b/i,
  /\bALTER\s+TYPE\b/i,
  /\bDROP\s+TYPE\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i,
  /\bDROP\s+FUNCTION\b/i,
  /\bALTER\s+FUNCTION\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bADD\s+COLUMN\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bALTER\s+COLUMN\b/i,
];

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function migrationCanChangeGeneratedTypes(sql: string): boolean {
  const stripped = stripSqlComments(sql);
  return TYPE_CHANGING_SQL.some((pattern) => pattern.test(stripped));
}

function gitCommitUnixTime(path: string, cwd: string): number | null {
  try {
    const output = execFileSync("git", ["log", "-1", "--format=%ct", "--", path], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output.length === 0) return null;
    const value = Number(output);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isShallowGitRepository(cwd: string): boolean {
  try {
    const output = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "true";
  } catch {
    return false;
  }
}

export function checkDbTypesDrift(projectDirectory = process.cwd()): DbTypesDriftResult {
  const typesPath = resolve(projectDirectory, generatedDatabaseTypesPath);
  const migrationsDir = resolve(projectDirectory, supabaseMigrationsDirectory);

  if (!existsSync(typesPath)) {
    return {
      exitCode: 1,
      latestMigration: null,
      messages: [`Missing generated types file: ${generatedDatabaseTypesPath}`],
    };
  }

  const types = readFileSync(typesPath, "utf8");
  if (types.trim().length === 0 || !types.includes("export type Database")) {
    return {
      exitCode: 1,
      latestMigration: null,
      messages: [
        `${generatedDatabaseTypesPath} is empty or is not a generated Database types file.`,
      ],
    };
  }

  if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
    return {
      exitCode: 1,
      latestMigration: null,
      messages: [`Missing migrations directory: ${supabaseMigrationsDirectory}`],
    };
  }

  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) {
    return {
      exitCode: 1,
      latestMigration: null,
      messages: [`No SQL migrations found in ${supabaseMigrationsDirectory}`],
    };
  }

  const latestMigration = migrations[migrations.length - 1]!;
  const latestVersion = latestMigration.match(/^(\d{14})_/)?.[1] ?? "unknown";
  const messages = [`Latest migration: ${latestMigration} (version ${latestVersion}).`];
  const latestSql = readFileSync(resolve(migrationsDir, latestMigration), "utf8");

  if (!migrationCanChangeGeneratedTypes(latestSql)) {
    messages.push(
      `OK: ${latestMigration} does not change generated types (policies, indexes, constraints, grants, or data only). Skipping the types-vs-migration timestamp comparison.`,
    );
    return { exitCode: 0, latestMigration, messages };
  }

  if (isShallowGitRepository(projectDirectory)) {
    messages.push(
      `ERROR: git history is shallow, so commit timestamps cannot prove ${generatedDatabaseTypesPath} was regenerated after type-changing ${latestMigration}. Fetch full history or run \`pnpm db:types\` against local Supabase and inspect the diff.`,
    );
    return { exitCode: 1, latestMigration, messages };
  }

  const typesTime = gitCommitUnixTime(generatedDatabaseTypesPath, projectDirectory);
  const migrationTime = gitCommitUnixTime(
    `${supabaseMigrationsDirectory}/${latestMigration}`,
    projectDirectory,
  );

  if (typesTime === null || migrationTime === null) {
    messages.push(
      "WARNING: git commit timestamps for the types file and/or latest migration are unavailable. This heuristic cannot prove types were regenerated after the latest type-changing migration. Run `pnpm db:types` against local Supabase and inspect the diff. Exiting 0 to avoid a flaky blocker.",
    );
    return { exitCode: 0, latestMigration, messages };
  }

  if (typesTime < migrationTime) {
    messages.push(
      `ERROR: ${generatedDatabaseTypesPath} last changed at ${typesTime}, but ${latestMigration} last changed at ${migrationTime}. Regenerated types look older than the latest type-changing migration. Run \`pnpm db:types\` against local Supabase and commit the result.`,
    );
    return { exitCode: 1, latestMigration, messages };
  }

  messages.push(
    `OK: generated types are at least as new as ${latestMigration} (types=${typesTime}, migration=${migrationTime}). This is a heuristic, not a full regen.`,
  );
  return { exitCode: 0, latestMigration, messages };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkDbTypesDrift();
  for (const message of result.messages) {
    if (message.startsWith("ERROR:")) {
      console.error(message);
    } else {
      console.log(message);
    }
  }
  process.exitCode = result.exitCode;
}
