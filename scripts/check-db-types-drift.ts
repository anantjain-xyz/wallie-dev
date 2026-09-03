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

function gitCommitUnixTime(path: string, cwd: string): number | null {
  try {
    const output = execFileSync("git", ["log", "-1", "--format=%ct", "--", path], {
      cwd,
      encoding: "utf8",
    }).trim();
    if (output.length === 0) return null;
    const value = Number(output);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
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

  // database.types.ts has no version header or migration stamp, so a filename
  // comment check is not available. Git commit timestamps are the remaining
  // heuristic; they are missing in shallow CI checkouts.
  const typesTime = gitCommitUnixTime(generatedDatabaseTypesPath, projectDirectory);
  const migrationTime = gitCommitUnixTime(
    `${supabaseMigrationsDirectory}/${latestMigration}`,
    projectDirectory,
  );

  if (typesTime === null || migrationTime === null) {
    messages.push(
      "WARNING: git commit timestamps for the types file and/or latest migration are unavailable (common in shallow CI checkouts). This heuristic cannot prove types were regenerated after the latest migration. Run `pnpm db:types` against local Supabase and inspect the diff. Exiting 0 to avoid a flaky blocker.",
    );
    return { exitCode: 0, latestMigration, messages };
  }

  if (typesTime < migrationTime) {
    messages.push(
      `ERROR: ${generatedDatabaseTypesPath} last changed at ${typesTime}, but ${latestMigration} last changed at ${migrationTime}. Regenerated types look older than the latest migration. Run \`pnpm db:types\` against local Supabase and commit the result.`,
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
