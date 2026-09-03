import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkDbTypesDrift,
  generatedDatabaseTypesPath,
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

  it("skips the timestamp comparison without git history instead of failing", () => {
    const projectDirectory = makeProjectDirectory();
    mkdirSync(join(projectDirectory, "src/lib/supabase"), { recursive: true });
    mkdirSync(join(projectDirectory, supabaseMigrationsDirectory), { recursive: true });
    writeFileSync(
      join(projectDirectory, generatedDatabaseTypesPath),
      "export type Database = {}\n",
    );
    writeFileSync(
      join(projectDirectory, supabaseMigrationsDirectory, "20260901160000_example.sql"),
      "-- placeholder\n",
    );

    const result = checkDbTypesDrift(projectDirectory);
    expect(result.exitCode).toBe(0);
    expect(result.latestMigration).toBe("20260901160000_example.sql");
    expect(result.messages.some((message) => message.startsWith("WARNING:"))).toBe(true);
  });

  it("accepts the committed types file against the latest checked-in migration", () => {
    const result = checkDbTypesDrift();
    expect(result.exitCode).toBe(0);
    expect(result.latestMigration).toMatch(/^\d{14}_.+\.sql$/);
  });
});
