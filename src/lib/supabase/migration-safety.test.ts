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

function verifyWithBase(baseSql: string, newSql: string) {
  const baseMigrations = { "20260728000000_existing.sql": baseSql };
  return verifyMigrationSafety({
    baseMigrations,
    currentMigrations: {
      ...baseMigrations,
      "20260729000000_fixture.sql": newSql,
    },
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

  it("accepts a compatible function-overload replacement without an exemption", () => {
    expect(verifyNew(fixture("valid", "function-overload-replacement.sql"))).toEqual([]);
  });

  it("accepts an ordered function recreation only when its deployed contract is unchanged", () => {
    const baseSql = `create function public.lookup_job(job_id uuid)
returns text language sql as 'select job_id::text';`;
    const newSql = `drop function public.lookup_job(uuid);
create function public.lookup_job(target_id uuid)
returns text language sql as 'select target_id::text';`;

    expect(verifyWithBase(baseSql, newSql)).toEqual([]);
  });

  it.each([
    [
      `create function public.lookup_job(job_id uuid)
returns text language sql as 'select job_id::text';`,
      `create function public.lookup_job(target_id uuid)
returns text language sql as 'select target_id::text';
drop function public.lookup_job(uuid);`,
      "drop-function:public.lookup_job(uuid)",
    ],
    [
      `create function public.lookup_job(job_id uuid)
returns text language sql as 'select job_id::text';`,
      `drop function public.lookup_job(uuid);
create function public.lookup_job(uuid) returns bigint language sql as 'select 1';`,
      "drop-function:public.lookup_job(uuid)",
    ],
    [
      `create function public.lookup_job(ids integer[])
returns text language sql as 'select ids::text';`,
      `drop function public.lookup_job(integer[]);
create function public.lookup_job(text[]) returns text language sql as 'select 1';`,
      "drop-function:public.lookup_job(integer[])",
    ],
  ])(
    "requires an exact waiver for incompatible function recreation",
    (baseSql, newSql, operationKey) => {
      expect(verifyWithBase(baseSql, newSql)).toEqual([
        expect.objectContaining({
          code: "unsafe-operation",
          operationKey,
        }),
      ]);
    },
  );

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
    [
      "alter type public.job_result alter attribute status type bigint;",
      "replace-attribute-type:public.job_result.status",
    ],
    ["drop index concurrently if exists public.jobs_idx;", "drop-index:public.jobs_idx"],
    ["alter index public.jobs_pkey rename to jobs_id_idx;", "rename-index:public.jobs_pkey"],
    [
      "drop trigger if exists touch_updated_at on public.jobs;",
      "drop-trigger:public.jobs.touch_updated_at",
    ],
    ["drop policy if exists member_read on public.jobs;", "drop-policy:public.jobs.member_read"],
    [
      "alter policy member_read on public.jobs rename to workspace_member_read;",
      "rename-policy:public.jobs.member_read",
    ],
    [
      "alter table public.jobs alter column workspace_id set not null;",
      "set-not-null:public.jobs.workspace_id",
    ],
  ])("classifies additional incompatible DDL: %s", (sql, operationKey) => {
    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({ code: "unsafe-operation", operationKey }),
    ]);
  });

  it("does not let a policy waiver authorize the same policy name on another relation", () => {
    const sql = `-- wallie-migration-safety: allow drop-policy:public.jobs.member_read owner=@anantjain-xyz issue=OP-387
drop policy member_read on public.sessions;`;

    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({
        code: "unused-waiver",
        operationKey: "drop-policy:public.jobs.member_read",
      }),
      expect.objectContaining({
        code: "unsafe-operation",
        operationKey: "drop-policy:public.sessions.member_read",
      }),
    ]);
  });

  it("accepts a policy waiver only for its exact relation and policy", () => {
    const sql = `-- wallie-migration-safety: allow drop-policy:public.jobs.member_read owner=@anantjain-xyz issue=OP-387
drop policy member_read on public.jobs;`;

    expect(verifyNew(sql)).toEqual([]);
  });

  it("does not let a trigger waiver authorize the same trigger name on another relation", () => {
    const sql = `-- wallie-migration-safety: allow drop-trigger:public.jobs.touch_updated_at owner=@anantjain-xyz issue=OP-387
drop trigger touch_updated_at on public.sessions;`;

    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({
        code: "unused-waiver",
        operationKey: "drop-trigger:public.jobs.touch_updated_at",
      }),
      expect.objectContaining({
        code: "unsafe-operation",
        operationKey: "drop-trigger:public.sessions.touch_updated_at",
      }),
    ]);
  });

  it.each([
    ["drop-trigger:public.jobs.touch_updated_at", "drop trigger touch_updated_at on public.jobs;"],
    [
      "set-not-null:public.jobs.workspace_id",
      "alter table public.jobs alter column workspace_id set not null;",
    ],
  ])("accepts an exact waiver for %s", (operationKey, statement) => {
    const sql = `-- wallie-migration-safety: allow ${operationKey} owner=@anantjain-xyz issue=OP-387
${statement}`;

    expect(verifyNew(sql)).toEqual([]);
  });

  it.each([
    [
      `do $block$
begin
  execute 'DROP TABLE public.jobs';
end
$block$;`,
      "drop-table:public.jobs",
    ],
    [
      `do $block$
begin
  alter table public.jobs rename column id to job_id;
end
$block$;`,
      "rename-column:public.jobs.id",
    ],
    [
      `do $block$
begin
  execute format('DROP TABLE %I.%I', 'public', 'jobs');
end
$block$;`,
      "drop-table:public.jobs",
    ],
    [
      `do $block$
begin
  execute 'select 1; ' || 'DROP TABLE public.jobs';
end
$block$;`,
      "drop-table:public.jobs",
    ],
  ])("detects destructive SQL executed inside a DO block", (sql, operationKey) => {
    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({ code: "unsafe-operation", line: 3, operationKey }),
    ]);
  });

  it("allows an exact waiver for constant destructive SQL executed inside a DO block", () => {
    const sql = `-- wallie-migration-safety: allow drop-table:public.jobs owner=@anantjain-xyz issue=OP-387
do $block$
begin
  execute 'DROP TABLE public.jobs';
end
$block$;`;

    expect(verifyNew(sql)).toEqual([]);
  });

  it("fails closed when a DO block executes SQL that cannot be evaluated statically", () => {
    const sql = `do $block$
begin
  execute generated_ddl;
end
$block$;`;

    expect(verifyNew(sql)).toEqual([
      expect.objectContaining({
        code: "unsafe-operation",
        line: 3,
        operationKey: "execute-dynamic-sql:do",
      }),
    ]);
  });

  it("allows one exact waiver for a non-static DO EXECUTE expression", () => {
    const sql = `-- wallie-migration-safety: allow execute-dynamic-sql:do owner=@anantjain-xyz issue=OP-387
do $block$
begin
  execute generated_ddl;
end
$block$;`;

    expect(verifyNew(sql)).toEqual([]);
  });

  it("keeps comments and non-executed strings inside DO blocks opaque", () => {
    const sql = `do $block$
begin
  -- execute 'DROP TABLE public.jobs';
  raise notice 'DROP TABLE public.jobs';
end
$block$;`;

    expect(verifyNew(sql)).toEqual([]);
  });

  it("fails closed on unterminated PostgreSQL strings and comments", () => {
    expect(issueCodes("select $body$ DROP TABLE public.jobs;")).toEqual(["invalid-sql"]);
    expect(issueCodes("/* DROP TABLE public.jobs;")).toEqual(["invalid-sql"]);
  });

  it("requires repository-owner review for migration changes", () => {
    const codeowners = readFileSync(join(currentDir, "../../../.github/CODEOWNERS"), "utf8");

    expect(codeowners).toMatch(/^\/supabase\/migrations\/\s+@anantjain-xyz$/mu);
  });
});
