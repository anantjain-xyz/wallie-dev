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

  it("allows compatible CREATE OR REPLACE function overloads without an exemption", async () => {
    await expect(inspect(fixture("valid/function-overload-replacement.sql"))).resolves.toEqual([]);
  });

  it("does not let a safe function replacement exempt a dropped overload", async () => {
    const issues = await inspect(`
      drop function public.lookup_job(text);
      create or replace function public.lookup_job(job_id uuid)
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

  it("requires a waiver for additive shapes that break old writers", async () => {
    const issues = await inspect("alter table public.jobs add column workspace_id uuid not null;");

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('add-not-null-column:"public"."jobs"."workspace_id"'),
      }),
    ]);
  });

  it("distinguishes additive permissive policies from restrictive policies", async () => {
    const issues = await inspect(`
      create policy read_jobs on public.jobs using (true);
      create policy active_jobs on public.jobs as restrictive using (archived_at is null);
    `);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unwaived-operation",
        message: expect.stringContaining('add-restrictive-policy:"public"."jobs"."active_jobs"'),
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
