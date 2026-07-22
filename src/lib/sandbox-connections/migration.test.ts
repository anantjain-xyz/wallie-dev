import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260721000001_add_e2b_daytona_sandbox_providers.sql"),
  "utf8",
);

describe("sandbox provider migration", () => {
  it("defaults and backfills workspace selection to Vercel", () => {
    expect(migration).toContain("active_provider text not null default 'vercel'");
    expect(migration).toContain("select id, 'vercel'");
    expect(migration).toContain("workspaces_seed_sandbox_settings");
  });

  it("stores typed encrypted connections without granting secret columns", () => {
    expect(migration).toContain("create table public.workspace_e2b_sandbox_connections");
    expect(migration).toContain("create table public.workspace_daytona_sandbox_connections");
    expect(migration).toContain("encrypted_api_key text not null");
    expect(migration).toContain("workspace_e2b_sandbox_connections_select_membership");
    expect(migration).toContain("workspace_daytona_sandbox_connections_select_membership");

    const authenticatedGrants = migration
      .split("grant select (")
      .slice(1)
      .map((grant) => grant.slice(0, grant.indexOf("to authenticated") + "to authenticated".length))
      .join("\n");
    expect(authenticatedGrants).not.toContain("encrypted_api_key");
  });

  it("coordinates switching and connection mutation with active work", () => {
    expect(migration).toContain(
      "create or replace function public.begin_sandbox_connection_mutation",
    );
    expect(migration).toContain("create or replace function public.set_active_sandbox_provider");
    expect(migration).toContain("and revision = expected_revision");
    expect(migration).toContain("status in ('queued', 'started', 'running')");
    expect(migration).toContain(
      "where workspace_id = target_workspace_id\n      and status = 'running'",
    );
  });

  it("reserves Codex auth flows atomically with sandbox connection mutations", () => {
    expect(migration).toContain("create or replace function public.begin_codex_device_auth_flow");
    expect(migration).toContain(
      "perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0))",
    );
    expect(migration).toContain("'provisioning:' || flow_id::text");
    expect(migration).toContain("grant execute on function public.begin_codex_device_auth_flow");
  });

  it("backfills and persists exact provider connection revisions", () => {
    expect(migration).toContain("add column sandbox_connection_revision uuid");
    expect(migration).toContain("run.sandbox_vercel_team_id = connection.team_id");
    expect(migration).toContain("check_row.sandbox_vercel_project_id = connection.project_id");
    expect(migration).toContain("new.connection_revision := gen_random_uuid()");
  });

  it("allows pre-provision Vercel capability failures to become terminal", () => {
    expect(migration).toContain("status in ('running', 'error')");
    expect(migration).toContain("and sandbox_id is null");
    expect(migration).toContain("and sandbox_vercel_team_id is null");
    expect(migration).toContain("and sandbox_vercel_project_id is null");
  });
});
