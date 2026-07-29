import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type MigrationSafetyIssueCode, verifyMigrationSafety } from "./migration-safety";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, "__fixtures__/migration-safety");
const waiverOwners = ["@anantjain-xyz"];

function fixture(category: "invalid" | "valid", name: string): string {
  return readFileSync(join(fixturesDir, category, name), "utf8");
}

function verifyNew(sql: string) {
  return verifyMigrationSafety({
    baseMigrations: {},
    currentMigrations: { "20260729000000_fixture.sql": sql },
    waiverOwners,
  });
}

function issueCodes(sql: string): MigrationSafetyIssueCode[] {
  return verifyNew(sql).map((issue) => issue.code);
}

describe("migration safety", () => {
  it("rejects edits, deletions, and renames of every migration on the comparison base", () => {
    const baseMigrations = {
      "20260422000000_init.sql": "create table baseline (id uuid);",
      "20260723000000_existing.sql": "alter table baseline add column name text;",
    };

    const issues = verifyMigrationSafety({
      baseMigrations,
      currentMigrations: {
        "20260422000000_init.sql": "create table baseline (id bigint);",
        "20260729000000_renamed.sql": baseMigrations["20260723000000_existing.sql"],
      },
      waiverOwners,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "historical-migration-changed",
          file: "20260422000000_init.sql",
        }),
        expect.objectContaining({
          code: "historical-migration-missing",
          file: "20260723000000_existing.sql",
        }),
      ]),
    );
  });

  it("ignores DROP and RENAME inside comments, strings, and multiline function bodies", () => {
    expect(verifyNew(fixture("valid", "comments-strings-multiline.sql"))).toEqual([]);
  });

  it("accepts a narrow, owned waiver that matches one retirement operation", () => {
    expect(verifyNew(fixture("valid", "approved-retirement.sql"))).toEqual([]);
  });

  it("accepts an exact function-overload drop and recreation in the same migration", () => {
    expect(verifyNew(fixture("valid", "function-overload-replacement.sql"))).toEqual([]);
  });

  it("does not accept a function creation followed by a drop as a replacement", () => {
    const sql = `create function public.lookup_job(uuid) returns text language sql as 'select 1';
drop function public.lookup_job(uuid);`;

    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({
        code: "unsafe-operation",
        operationKey: "drop-function:public.lookup_job(uuid)",
      }),
    ]);
  });

  it.each([
    ["drop-column.sql", "drop-column:public.agent_jobs.active_job_id"],
    ["rename-column.sql", "rename-column:public.agent_jobs.active_job_id"],
    ["replace-view.sql", "replace-view:public.ready_jobs"],
  ])("rejects the unsafe operation in %s", (name, operationKey) => {
    expect(verifyNew(fixture("invalid", name))).toEqual([
      expect.objectContaining({
        code: "unsafe-operation",
        operationKey,
      }),
    ]);
  });

  it("rejects a waiver whose exact operation is absent", () => {
    expect(issueCodes(fixture("invalid", "unused-waiver.sql"))).toEqual(["unused-waiver"]);
  });

  it("rejects annotations without an approved owner", () => {
    const sql = `-- wallie-migration-safety: allow drop-table:public.jobs owner=@unknown issue=OP-387
drop table public.jobs;`;

    expect(issueCodes(sql)).toEqual(["invalid-waiver", "unsafe-operation"]);
  });

  it("does not let a waiver approve a second copy of the same operation", () => {
    const sql = `-- wallie-migration-safety: allow drop-table:public.jobs owner=@anantjain-xyz issue=OP-387
drop table public.jobs;
drop table public.jobs;`;

    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({
        code: "unsafe-operation",
        operationKey: "drop-table:public.jobs",
      }),
    ]);
  });

  it.each([
    ["alter table public.jobs alter id type bigint;", "replace-column-type:public.jobs.id"],
    ["alter table only public.jobs * rename id to job_id;", "rename-column:public.jobs.id"],
    ["alter index public.jobs_pkey rename to jobs_id_idx;", "rename-index:public.jobs_pkey"],
    [
      "alter policy member_read on public.jobs rename to workspace_member_read;",
      "rename-policy:member_read",
    ],
  ])("classifies additional incompatible DDL: %s", (sql, operationKey) => {
    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({ code: "unsafe-operation", operationKey }),
    ]);
  });

  it("fails closed on unterminated PostgreSQL strings and comments", () => {
    expect(issueCodes("select $body$ DROP TABLE public.jobs;")).toEqual(["invalid-sql"]);
    expect(issueCodes("/* DROP TABLE public.jobs;")).toEqual(["invalid-sql"]);
  });
});
