import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkDbTypesDrift,
  generatedDatabaseTypesPath,
  isShallowGitRepository,
  migrationCanChangeGeneratedTypes,
  supabaseMigrationsDirectory,
} from "../../../scripts/check-db-types-drift";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeProjectDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "wallie-db-types-drift-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeMinimalProject(directory: string, sql: string, migrationName: string) {
  mkdirSync(join(directory, "src/lib/supabase"), { recursive: true });
  mkdirSync(join(directory, supabaseMigrationsDirectory), { recursive: true });
  writeFileSync(join(directory, generatedDatabaseTypesPath), "export type Database = {}\n");
  writeFileSync(join(directory, supabaseMigrationsDirectory, migrationName), sql);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(directory: string) {
  git(directory, ["init"]);
  git(directory, ["config", "user.email", "drift@example.com"]);
  git(directory, ["config", "user.name", "Drift Test"]);
}

function commitAll(directory: string, message: string, date: string) {
  git(directory, ["add", "-A"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", message], {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

describe("migrationCanChangeGeneratedTypes", () => {
  it("ignores policies, indexes, constraints, grants, and comments", () => {
    expect(
      migrationCanChangeGeneratedTypes(`
        -- create table public.ignored_in_comments (id uuid);
        create policy example on public.sessions for select using (true);
        create index sessions_title_idx on public.sessions (title);
        alter table public.workspace_agent_config
          drop constraint if exists workspace_agent_config_value_json_known_keys;
        alter table public.workspace_agent_config
          add constraint workspace_agent_config_value_json_known_keys check (true);
        grant select on public.sessions to authenticated;
      `),
    ).toBe(false);
  });

  it("detects table, function, type, view, and column changes", () => {
    expect(migrationCanChangeGeneratedTypes("create table public.example (id uuid);")).toBe(true);
    expect(migrationCanChangeGeneratedTypes("drop table public.example;")).toBe(true);
    expect(
      migrationCanChangeGeneratedTypes(
        "create or replace function public.example() returns void as $$ $$;",
      ),
    ).toBe(true);
    expect(migrationCanChangeGeneratedTypes("alter table public.example add column n int;")).toBe(
      true,
    );
  });
});

describe("generated database types drift heuristic", () => {
  it("fails when the generated types file is missing", () => {
    const projectDirectory = makeProjectDirectory();

    expect(checkDbTypesDrift(projectDirectory)).toEqual({
      exitCode: 1,
      latestMigration: null,
      messages: [`Missing generated types file: ${generatedDatabaseTypesPath}`],
    });
  });

  it("fails when the generated types file is empty", () => {
    const projectDirectory = makeProjectDirectory();
    mkdirSync(join(projectDirectory, "src/lib/supabase"), { recursive: true });
    writeFileSync(join(projectDirectory, generatedDatabaseTypesPath), "   \n");

    expect(checkDbTypesDrift(projectDirectory).exitCode).toBe(1);
  });

  it("fails when no SQL migrations are present", () => {
    const projectDirectory = makeProjectDirectory();
    mkdirSync(join(projectDirectory, "src/lib/supabase"), { recursive: true });
    mkdirSync(join(projectDirectory, supabaseMigrationsDirectory), { recursive: true });
    writeFileSync(
      join(projectDirectory, generatedDatabaseTypesPath),
      "export type Database = {}\n",
    );

    expect(checkDbTypesDrift(projectDirectory)).toEqual({
      exitCode: 1,
      latestMigration: null,
      messages: [`No SQL migrations found in ${supabaseMigrationsDirectory}`],
    });
  });

  it("skips the timestamp comparison when the latest migration cannot change types", () => {
    const projectDirectory = makeProjectDirectory();
    writeMinimalProject(
      projectDirectory,
      "create policy example on public.sessions for select using (true);\n",
      "20260901160000_example.sql",
    );

    const result = checkDbTypesDrift(projectDirectory);
    expect(result.exitCode).toBe(0);
    expect(result.latestMigration).toBe("20260901160000_example.sql");
    expect(
      result.messages.some((message) => message.includes("does not change generated types")),
    ).toBe(true);
  });

  it("warns without failing when type-changing SQL has no git history", () => {
    const projectDirectory = makeProjectDirectory();
    writeMinimalProject(
      projectDirectory,
      "create table public.example (id uuid);\n",
      "20260901160000_example.sql",
    );

    const result = checkDbTypesDrift(projectDirectory);
    expect(result.exitCode).toBe(0);
    expect(result.messages.some((message) => message.startsWith("WARNING:"))).toBe(true);
  });

  it("fails when generated types are older than a type-changing migration", () => {
    const projectDirectory = makeProjectDirectory();
    writeMinimalProject(
      projectDirectory,
      "create table public.example (id uuid);\n",
      "20260901160000_example.sql",
    );
    initGitRepo(projectDirectory);
    commitAll(projectDirectory, "types", "2020-01-01T00:00:00Z");
    writeFileSync(
      join(projectDirectory, supabaseMigrationsDirectory, "20260901170000_create.sql"),
      "create table public.newer (id uuid);\n",
    );
    commitAll(projectDirectory, "migration", "2021-01-01T00:00:00Z");

    const result = checkDbTypesDrift(projectDirectory);
    expect(result.exitCode).toBe(1);
    expect(result.messages.some((message) => message.startsWith("ERROR:"))).toBe(true);
  });

  it("fails a shallow clone instead of treating equal timestamps as proof", () => {
    const origin = makeProjectDirectory();
    writeMinimalProject(
      origin,
      "create table public.example (id uuid);\n",
      "20260901160000_example.sql",
    );
    initGitRepo(origin);
    commitAll(origin, "initial", "2020-01-01T00:00:00Z");

    const cloneParent = makeProjectDirectory();
    const clone = join(cloneParent, "checkout");
    git(cloneParent, ["clone", "--depth", "1", "--no-local", origin, "checkout"]);
    expect(isShallowGitRepository(clone)).toBe(true);

    const result = checkDbTypesDrift(clone);
    expect(result.exitCode).toBe(1);
    expect(result.messages.some((message) => message.includes("shallow"))).toBe(true);
  });

  it.skipIf(isShallowGitRepository())(
    "accepts the committed types file against the latest checked-in migration",
    () => {
      // GitHub Actions checkout defaults to fetch-depth 1. A type-changing
      // latest migration then fails this heuristic because timestamps cannot
      // be trusted. The isolated shallow-clone test covers that path; this
      // assertion needs full history.
      const result = checkDbTypesDrift();
      expect(result.exitCode).toBe(0);
      expect(result.latestMigration).toMatch(/^\d{14}_.+\.sql$/);
    },
  );
});
