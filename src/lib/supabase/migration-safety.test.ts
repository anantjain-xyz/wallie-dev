import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type MigrationFiles,
  type MigrationSafetyIssue,
  verifyMigrationSafety,
} from "./migration-safety";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = join(currentDir, "__fixtures__/migration-safety");
const baseMigrations: MigrationFiles = {
  "20260422000000_init.sql": "create table public.existing (id uuid primary key);\n",
};

function fixture(path: string): string {
  return readFileSync(join(fixturesDirectory, path), "utf8");
}

async function inspect(
  sql: string,
  waiverOwners: readonly string[] = ["@anantjain-xyz"],
): Promise<MigrationSafetyIssue[]> {
  return verifyMigrationSafety({
    baseMigrations,
    currentMigrations: {
      ...baseMigrations,
      "20260729000000_candidate.sql": sql,
    },
    waiverOwners,
  });
}

function issueCodes(issues: readonly MigrationSafetyIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("migration safety", () => {
  it("separately rejects edits, deletions, and renames of historical migrations", async () => {
    const base = {
      "20260422000000_init.sql": "select 1;\n",
      "20260423000000_deleted.sql": "select 2;\n",
      "20260424000000_renamed.sql": "select 3;\n",
    };
    const issues = await verifyMigrationSafety({
      baseMigrations: base,
      currentMigrations: {
        "20260422000000_init.sql": "select 10;\n",
        "20260424000000_new_name.sql": "select 3;\n",
      },
      waiverOwners: [],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "historical-migration-edited",
          file: "20260422000000_init.sql",
        }),
        expect.objectContaining({
          code: "historical-migration-deleted",
          file: "20260423000000_deleted.sql",
        }),
        expect.objectContaining({
          code: "historical-migration-renamed",
          file: "20260424000000_renamed.sql",
        }),
      ]),
    );
  });

  it("does not treat an identical historical migration as changed", async () => {
    const issues = await verifyMigrationSafety({
      baseMigrations,
      currentMigrations: baseMigrations,
      waiverOwners: [],
    });

    expect(issues).toEqual([]);
  });

  it("uses the PostgreSQL AST so comments, strings, and multiline bodies stay opaque", async () => {
    await expect(inspect(fixture("valid/comments-strings-multiline.sql"))).resolves.toEqual([]);
  });

  it("allows same-migration overload replacements that preserve each security mode", async () => {
    await expect(inspect(fixture("valid/function-overload-replacement.sql"))).resolves.toEqual([]);
  });

  it("does not let a safe function replacement exempt a dropped overload", async () => {
    const issues = await inspect(`
      drop function public.lookup_job(text);
      create function public.lookup_job(job_id uuid)
      returns text language sql as $$ select 'replacement' $$;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('drop-function:"public"."lookup_job"("text")'),
      }),
    ]);
  });

  it("keeps SECURITY DEFINER replacement waivers overload-specific", async () => {
    const issues = await inspect(`
      create function public.lookup_job(job_key text)
      returns text language sql security invoker as $$ select 'initial overload' $$;
      create or replace function public.lookup_job(job_id uuid)
      returns text language sql security definer as $$ select 'replacement' $$;
      create or replace function public.lookup_job(job_key text)
      returns text language sql security invoker as $$ select 'safe overload' $$;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining(
          'replace-function-security-definer:"public"."lookup_job"("uuid")',
        ),
      }),
    ]);
  });

  it("requires exact waivers when a replacement's prior security mode is unproven", async () => {
    const issues = await inspect(`
      -- wallie-migration-safety: allow replace-function-security-invoker:"public"."lookup_job"("uuid") owner=@anantjain-xyz issue=OP-387
      create or replace function public.lookup_job(job_id uuid)
      returns text language sql security invoker as $$ select 'waived overload' $$;
      create or replace function public.lookup_job(job_key text)
      returns text language sql as $$ select 'unproven implicit invoker overload' $$;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining(
          'replace-function-security-invoker:"public"."lookup_job"("text")',
        ),
      }),
    ]);
  });

  it("requires a waiver when a same-migration replacement drops SECURITY DEFINER", async () => {
    const issues = await inspect(`
      create function public.elevated_job()
      returns text language sql security definer as $$ select 'initial' $$;
      create or replace function public.elevated_job()
      returns text language sql as $$ select 'implicit invoker replacement' $$;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining(
          'replace-function-security-invoker:"public"."elevated_job"()',
        ),
      }),
    ]);
  });

  it("accepts a narrow owned and issue-linked retirement waiver", async () => {
    await expect(inspect(fixture("valid/approved-retirement.sql"))).resolves.toEqual([]);
  });

  it("rejects an unwaived multiline DROP COLUMN", async () => {
    const issues = await inspect(fixture("invalid/drop-column.sql"));

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('drop-column:"public"."agent_jobs"."active_job_id"'),
      }),
    ]);
  });

  it("rejects an unwaived multiline column rename", async () => {
    const issues = await inspect(fixture("invalid/rename-column.sql"));

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining(
          'rename-column:"public"."agent_jobs"."active_job_id"->"retired_active_job_id"',
        ),
      }),
    ]);
  });

  it("classifies CREATE OR REPLACE VIEW as an incompatible replacement", async () => {
    const issues = await inspect(fixture("invalid/replace-view.sql"));

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('replace-view:"public"."ready_jobs"'),
      }),
    ]);
  });

  it("fails closed when PostgreSQL rejects the SQL", async () => {
    const issues = await inspect(fixture("invalid/parse-error.sql"));

    expect(issueCodes(issues)).toEqual(["sql-parse-error"]);
  });

  it.each(["unterminated-comment.sql", "unterminated-string.sql"])(
    "fails closed on %s rather than scanning its text",
    async (fixtureName) => {
      const issues = await inspect(fixture(`invalid/${fixtureName}`));

      expect(issueCodes(issues)).toEqual(["sql-parse-error"]);
    },
  );

  it("fails closed on unsupported executable DDL containers", async () => {
    const issues = await inspect(fixture("invalid/unsupported-do.sql"));

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unsupported-ddl",
        message: expect.stringContaining("DoStmt is outside the supported migration subset"),
      }),
    ]);
  });

  it("fails closed on opaque procedure calls", async () => {
    const issues = await inspect("call public.retire_sessions();");

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unsupported-ddl",
        message: expect.stringContaining("CallStmt is outside the supported migration subset"),
      }),
    ]);
  });

  it("fails closed on SELECT function calls while allowing inspectable data-only SELECTs", async () => {
    const issues = await inspect(`
      select 1;
      select status from public.sessions where id is null;
      select public.destructive_function();
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unsupported-ddl",
        message: expect.stringContaining("SELECT with an opaque function invocation"),
      }),
    ]);
  });

  it("fails closed on other unknown PostgreSQL DDL instead of accepting it", async () => {
    const issues = await inspect(
      "create server remote_db foreign data wrapper postgres_fdw options (host 'db');",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unsupported-ddl",
        message: expect.stringContaining("outside the supported migration subset"),
      }),
    ]);
  });

  it("rejects a waiver whose canonical operation is absent", async () => {
    const issues = await inspect(fixture("invalid/unused-waiver.sql"));

    expect(issueCodes(issues)).toEqual(["unused-waiver"]);
  });

  it("rejects an orphan waiver after the final statement", async () => {
    const issues = await inspect(`
      create table public.safe_addition (id uuid primary key);
      -- wallie-migration-safety: allow drop-table:"public"."jobs" owner=@anantjain-xyz issue=OP-387
    `);

    expect(issueCodes(issues)).toEqual(["unused-waiver"]);
  });

  it("rejects malformed waiver metadata", async () => {
    const issues = await inspect(`
      -- wallie-migration-safety: allow drop-column:"public"."jobs"."old" owner=team issue=387
      alter table public.jobs drop column old;
    `);

    expect(issueCodes(issues)).toEqual(["invalid-waiver", "unwaived-operation"]);
  });

  it("rejects waiver owners outside the repository-approved owner list", async () => {
    const issues = await inspect(
      `
        -- wallie-migration-safety: allow drop-column:"public"."jobs"."old" owner=@other-team issue=OP-387
        alter table public.jobs drop column old;
      `,
      ["@anantjain-xyz"],
    );

    expect(issueCodes(issues)).toEqual(["unauthorized-waiver-owner", "unwaived-operation"]);
  });

  it("consumes each waiver once even when a statement repeats the operation", async () => {
    const issues = await inspect(`
      -- wallie-migration-safety: allow drop-column:"public"."jobs"."old" owner=@anantjain-xyz issue=OP-387
      alter table public.jobs
        drop column old,
        drop column old;
    `);

    expect(issueCodes(issues)).toEqual(["unwaived-operation"]);
  });

  it("keeps AST identifier components distinct in canonical waiver keys", async () => {
    const issues = await inspect(`
      -- wallie-migration-safety: allow drop-column:"public"."jobs"."old" owner=@anantjain-xyz issue=OP-387
      alter table public."jobs.old" drop column old;
    `);

    expect(issueCodes(issues)).toEqual(["unwaived-operation", "unused-waiver"]);
    expect(issues[0].message).toContain('drop-column:"public"."jobs.old"."old"');
  });

  it("does not read waiver-like text from a function body", async () => {
    const issues = await inspect(`
      create function public.waiver_text()
      returns text language sql as $$
        -- wallie-migration-safety: allow drop-column:"public"."jobs"."old" owner=@anantjain-xyz issue=OP-387
        select 'not metadata'
      $$;
      alter table public.jobs drop column old;
    `);

    expect(issueCodes(issues)).toEqual(["unwaived-operation"]);
  });

  it("requires separate exact waivers for every object in a multi-object DROP", async () => {
    const issues = await inspect(`
      -- wallie-migration-safety: allow drop-table:"public"."first" owner=@anantjain-xyz issue=OP-387
      drop table public.first, public.second;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('drop-table:"public"."second"'),
      }),
    ]);
  });

  it("keeps CASCADE distinct from the default RESTRICT drop waiver identity", async () => {
    const issues = await inspect(`
      drop table public.jobs;
      -- wallie-migration-safety: allow drop-table:"public"."sessions" owner=@anantjain-xyz issue=OP-387
      drop table public.sessions cascade;
    `);

    expect(issueCodes(issues)).toEqual([
      "unwaived-operation",
      "unwaived-operation",
      "unused-waiver",
    ]);
    expect(issues[0].message).toContain('drop-table:"public"."jobs"');
    expect(issues[1].message).toContain('drop-table:"public"."sessions":cascade');
    expect(issues[2].message).toContain('waiver drop-table:"public"."sessions"');
  });

  it("retains overload arrays and relation-qualified policy and trigger identities", async () => {
    const issues = await inspect(`
      drop function public.lookup_job(integer[]);
      drop policy same_name on public.first;
      drop trigger same_name on public.second;
    `);

    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('drop-function:"public"."lookup_job"("pg_catalog"."int4"[])'),
      expect.stringContaining('drop-policy:"public"."first"."same_name"'),
      expect.stringContaining('drop-trigger:"public"."second"."same_name"'),
    ]);
  });

  it("derives named and unnamed constraint waiver keys from canonical AST identities", async () => {
    const issues = await inspect(`
      alter table public.jobs
        add constraint jobs_external_id_key unique (external_id),
        add check (status <> 'retired'),
        add check (status <> 'deleted');
    `);

    expect(issues).toHaveLength(3);
    expect(issues[0].message).toContain(
      'alter-table-add-constraint:"public"."jobs"."jobs_external_id_key"',
    );
    expect(issues[1].message).toContain(
      'alter-table-add-constraint:"public"."jobs"."unnamed-constr_check-',
    );
    expect(issues[2].message).toContain(
      'alter-table-add-constraint:"public"."jobs"."unnamed-constr_check-',
    );
    expect(issues[1].message).not.toBe(issues[2].message);
  });

  it("classifies every relation in a TRUNCATE independently", async () => {
    const issues = await inspect("truncate public.first, public.second;");

    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('truncate-table:"public"."first"'),
      expect.stringContaining('truncate-table:"public"."second"'),
    ]);
  });

  it("classifies an unqualified DELETE while allowing targeted cleanup", async () => {
    const issues = await inspect(`
      delete from public.sessions;
      delete from public.sessions where id is null;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('delete-all-rows:"public"."sessions"'),
      }),
    ]);
  });

  it("classifies an unqualified UPDATE while allowing targeted updates", async () => {
    const issues = await inspect(`
      update public.sessions set status = 'retired';
      update public.sessions set status = 'retired' where id is null;
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('update-all-rows:"public"."sessions":ast-'),
      }),
    ]);
  });

  it("allows the explicit additive subset without a waiver", async () => {
    const issues = await inspect(`
      create table public.jobs (id uuid primary key, note text);
      alter table public.jobs add column created_at timestamptz;
      create index jobs_created_at_idx on public.jobs (created_at);
      create type public.job_state as enum ('ready');
      alter type public.job_state add value 'running';
      grant select on public.jobs to authenticated;
      insert into public.jobs (id) values ('00000000-0000-0000-0000-000000000000');
    `);

    expect(issues).toEqual([]);
  });

  it("requires a waiver for a unique index while allowing a non-unique index", async () => {
    const issues = await inspect(`
      create index jobs_created_at_idx on public.jobs (created_at);
      create unique index jobs_external_id_idx on public.jobs (external_id);
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining(
          'add-unique-index:"public"."jobs"."jobs_external_id_idx":ast-',
        ),
      }),
    ]);
  });

  it("requires a waiver for additive shapes that break old writers", async () => {
    const issues = await inspect("alter table public.jobs add column workspace_id uuid not null;");

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('add-not-null-column:"public"."jobs"."workspace_id"'),
      }),
    ]);
  });

  it("treats a PRIMARY KEY column addition as an implicit NOT NULL contract", async () => {
    const issues = await inspect("alter table public.jobs add column id uuid primary key;");

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('add-not-null-column:"public"."jobs"."id"'),
      }),
    ]);
  });

  it("requires waivers before enabling RLS or making a table unlogged", async () => {
    const issues = await inspect(`
      alter table public.jobs enable row level security;
      alter table public.sessions set unlogged;
    `);

    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('alter-table-enable-row-security:"public"."jobs"'),
      expect.stringContaining('alter-table-set-un-logged:"public"."sessions"'),
    ]);
  });

  it("requires waivers for permissive and restrictive RLS policies", async () => {
    const issues = await inspect(`
      create policy read_jobs on public.jobs using (true);
      create policy active_jobs on public.jobs as restrictive using (archived_at is null);
    `);

    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('add-permissive-policy:"public"."jobs"."read_jobs":ast-'),
      expect.stringContaining('add-restrictive-policy:"public"."jobs"."active_jobs":ast-'),
    ]);
  });

  it("requires waivers before enabling existing triggers", async () => {
    const issues = await inspect(`
      alter table public.jobs enable trigger job_trigger;
      alter table public.jobs enable trigger all;
      alter table public.jobs enable trigger user;
    `);

    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('alter-table-enable-trig:"public"."jobs"."job_trigger"'),
      expect.stringContaining('alter-table-enable-trig-all:"public"."jobs"'),
      expect.stringContaining('alter-table-enable-trig-user:"public"."jobs"'),
    ]);
  });

  it("rejects new migration versions that are not later than the comparison base", async () => {
    const base = {
      "20260729000000_base.sql": "select 1;\n",
    };
    const issues = await verifyMigrationSafety({
      baseMigrations: base,
      currentMigrations: {
        ...base,
        "20260728000000_backdated.sql": "select 1;\n",
        "20260729000000_same_version.sql": "select 1;\n",
        "20260730000000_forward.sql": "select 1;\n",
      },
      waiverOwners: [],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "backdated-migration",
        file: "20260728000000_backdated.sql",
      }),
      expect.objectContaining({
        code: "backdated-migration",
        file: "20260729000000_same_version.sql",
      }),
    ]);
  });

  it("requires separate canonical waivers for each ALTER POLICY replacement", async () => {
    const issues = await inspect(`
      alter policy active_jobs on public.jobs
        to authenticated
        using (archived_at is null)
        with check (workspace_id is not null);
    `);

    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('replace-policy-roles:"public"."jobs"."active_jobs":ast-'),
      expect.stringContaining('replace-policy-using:"public"."jobs"."active_jobs":ast-'),
      expect.stringContaining('replace-policy-with-check:"public"."jobs"."active_jobs":ast-'),
    ]);
  });
});
