import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  abandonedWorkflowLease,
  WORKFLOW_ABANDONED_EXIT,
  workflowHandoffWitness,
} from "../test/release/factory-workflow-handoff-contract";

type Fixture = { url: string; serviceKey: string; publishableKey: string };

export function checkFactoryWorkflowHandoff(
  databaseUrl: string,
  fixture: Fixture,
  env: NodeJS.ProcessEnv,
) {
  const database = new URL(databaseUrl);
  assert.equal(database.pathname, "/postgres");
  const proofRoot = resolve(".wallie/m11-qualification");
  mkdirSync(proofRoot, { recursive: true, mode: 0o700 });
  const proof = mkdtempSync(join(proofRoot, "handoff-"));
  const witnessPath = join(proof, "witness.json");
  const abandonedPath = join(proof, "abandoned-lease.json");

  function psql(args: string[], input?: string) {
    const result = spawnSync(
      "psql",
      [
        "-XqAtw",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        database.hostname.replace(/^\[|\]$/g, ""),
        "-p",
        database.port || "5432",
        "-U",
        decodeURIComponent(database.username),
        "-d",
        "postgres",
        ...args,
      ],
      {
        env: { ...env, PGPASSWORD: decodeURIComponent(database.password) },
        encoding: "utf8",
        input,
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || "psql did not exit cleanly";
      throw new Error(detail);
    }
    return result.stdout.trim();
  }

  const seed = psql([
    "-v",
    `op651_fixture_namespace=${randomInt(20000000, 90000000)}`,
    "-f",
    "test/release/factory-workflow-handoff-seed.psql",
  ]);
  const witness = workflowHandoffWitness.parse(JSON.parse(seed));
  writeFileSync(witnessPath, JSON.stringify(witness), { mode: 0o600 });

  function runNode(phase: "abandon" | "approve") {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/register-server-only.mjs",
        "--import",
        "tsx",
        "test/release/factory-workflow-handoff.ts",
      ],
      {
        env: {
          ...env,
          WALLIE_M11_WITNESS_PATH: witnessPath,
          WALLIE_M11_ABANDONED_PATH: abandonedPath,
          WALLIE_M11_HANDOFF_PHASE: phase,
        },
        stdio: ["ignore", phase === "approve" ? "pipe" : "inherit", "inherit"],
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  }

  assert.equal(runNode("abandon").status, WORKFLOW_ABANDONED_EXIT, "Node must lose the lease.");
  const abandoned = abandonedWorkflowLease.parse(JSON.parse(readFileSync(abandonedPath, "utf8")));
  assert.equal(
    psql(
      [
        "-v",
        `workspace=${witness.workspaceId}`,
        "-v",
        `session=${witness.sessionId}`,
        "-v",
        `run=${witness.inputRunId}`,
        "-v",
        `occurrence=${abandoned.occurrenceId}`,
        "-v",
        `lease=${abandoned.leaseId}`,
        "-v",
        `generation=${abandoned.generation}`,
      ],
      `begin;
      -- Admission needs a synthetic connection. Keep maintenance off external providers.
      update public.workspace_e2b_sandbox_connections set status = 'error'
      where workspace_id = :'workspace'::uuid;
      with expired as (
        update internal.factory_workflow_authoring_dispatches
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where (session_id, input_run_id, occurrence_id, lease_id, lease_generation) =
          (:'session'::uuid, :'run'::uuid, :'occurrence'::uuid, :'lease'::uuid, :'generation'::bigint)
          and completed_at is null
        returning 1
      ) select count(*) from expired;
      commit;`,
    ),
    "1",
    "Expire only the abandoned fixture lease.",
  );

  const workerd = spawnSync(
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "cloudflare/tests/factory-workflow-handoff.fixture.test.ts",
      "--config",
      "cloudflare/vitest.config.mts",
    ],
    {
      env: {
        ...env,
        WALLIE_FACTORY_RUNTIME_FIXTURE: JSON.stringify({ ...fixture, m11Handoff: witness }),
      },
      stdio: "inherit",
      timeout: 120_000,
    },
  );
  assert.equal(workerd.status, 0, "Workerd must recover the authored workflow.");

  const approved = runNode("approve");
  assert.equal(approved.status, 0, "Fresh Node must consume the exact approval receipt.");
  writeFileSync(join(proof, "result.log"), approved.stdout, { mode: 0o600 });
  process.stdout.write(approved.stdout);
  console.log(`M11 cross-runtime evidence is in ${proof}.`);
}
