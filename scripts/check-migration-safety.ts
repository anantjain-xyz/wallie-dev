import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type MigrationFiles, verifyMigrationSafety } from "../src/lib/supabase/migration-safety";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(repositoryRoot, "supabase/migrations");
const migrationPathPrefix = "supabase/migrations/";
const waiverOwners = ["@anantjain-xyz"];

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitLine(args: readonly string[]): string {
  return git(args).trim();
}

function requestedBaseRef(): string {
  const baseArgumentIndex = process.argv.indexOf("--base-ref");
  if (baseArgumentIndex !== -1) {
    const value = process.argv[baseArgumentIndex + 1];
    if (!value) throw new Error("--base-ref requires a Git ref");
    return value;
  }

  return process.env.MIGRATION_SAFETY_BASE_REF ?? "origin/main";
}

function comparisonBase(): string {
  const baseRef = requestedBaseRef();
  try {
    return gitLine(["merge-base", "HEAD", baseRef]);
  } catch {
    throw new Error(
      `cannot resolve migration comparison base ${baseRef}; fetch that ref or pass --base-ref <ref>`,
    );
  }
}

function baseMigrations(base: string): MigrationFiles {
  const files = gitLine(["ls-tree", "-r", "--name-only", base, "--", migrationPathPrefix])
    .split("\n")
    .filter((file) => file.startsWith(migrationPathPrefix) && file.endsWith(".sql"));

  return Object.fromEntries(
    files.map((file) => [file.slice(migrationPathPrefix.length), git(["show", `${base}:${file}`])]),
  );
}

function currentMigrations(): MigrationFiles {
  return Object.fromEntries(
    readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => [
        relative(migrationsDirectory, join(migrationsDirectory, file)),
        readFileSync(join(migrationsDirectory, file), "utf8"),
      ]),
  );
}

const base = comparisonBase();
const issues = verifyMigrationSafety({
  baseMigrations: baseMigrations(base),
  currentMigrations: currentMigrations(),
  waiverOwners,
});

if (issues.length > 0) {
  for (const issue of issues) {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    process.stderr.write(`${location} [${issue.code}] ${issue.message}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Migration safety verified against ${base.slice(0, 12)}.\n`);
}
