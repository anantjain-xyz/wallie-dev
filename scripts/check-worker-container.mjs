import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2] ?? "wallie-worker:local";
const prefix = `wallie-worker-smoke-${randomUUID()}`;
const network = `${prefix}-network`;
const fixture = `${prefix}-supabase`;
const worker = `${prefix}-worker`;

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  }
  return `${result.stdout ?? ""}${args[0] === "logs" ? (result.stderr ?? "") : ""}`.trim();
}

function cleanup() {
  docker(["rm", "--force", worker, fixture], { allowFailure: true });
  docker(["network", "rm", network], { allowFailure: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
}

function fixtureState() {
  return JSON.parse(
    docker([
      "exec",
      fixture,
      "node",
      "--input-type=module",
      "--eval",
      'console.log(await (await fetch("http://127.0.0.1:3001/_smoke/state")).text())',
    ]),
  );
}

try {
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    image,
    "--eval",
    `const assert = require("node:assert/strict");
     const fs = require("node:fs");
     assert.notEqual(process.getuid(), 0, "Image must run as non-root");
     assert.equal(process.env.NODE_ENV, "production");
     assert.equal(fs.existsSync("LICENSE"), true, "Repository license must ship");
     for (const path of [".env", ".env.local", ".git", "src/worker/config.test.ts"]) {
       assert.equal(fs.existsSync(path), false, path + " must not ship");
     }
     assert.equal(fs.existsSync("scripts/install-crash-handlers.mjs"), true);
     assert.equal(fs.existsSync("scripts/register-server-only.mjs"), true);
     console.log("Runtime image checks passed");`,
  ]);
  docker(["network", "create", "--internal", network]);
  docker([
    "run",
    "--detach",
    "--name",
    fixture,
    "--network",
    network,
    "--network-alias",
    "supabase",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    readFileSync(new URL("./fixtures/worker-container-supabase.mjs", import.meta.url), "utf8"),
  ]);
  // Poll the fixture before starting the worker; registration deliberately fails fast.
  const fixtureDeadline = Date.now() + 15_000;
  while (true) {
    try {
      fixtureState();
      break;
    } catch (error) {
      if (Date.now() >= fixtureDeadline) throw error;
      await setTimeout(250);
    }
  }
  docker([
    "run",
    "--detach",
    "--name",
    worker,
    "--network",
    network,
    "--env",
    "NEXT_PUBLIC_APP_URL=http://wallie:3000",
    "--env",
    "NEXT_PUBLIC_SUPABASE_URL=http://supabase:3001",
    "--env",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=worker-container-smoke-public",
    "--env",
    "SUPABASE_SECRET_KEY=worker-container-smoke-secret",
    "--env",
    `WALLIE_ENCRYPTION_KEY=${"ab".repeat(32)}`,
    image,
  ]);
  const deadline = Date.now() + 25_000;
  while (true) {
    const state = fixtureState();
    assert.deepEqual(state.errors, []);
    if (state.workerId && state.claims > 0 && state.heartbeats > 0 && state.cursorPolls > 0) break;
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", worker]),
      "true",
      "Worker exited before becoming ready",
    );
    assert.ok(Date.now() < deadline, "Worker did not register, poll, and heartbeat in time");
    await setTimeout(500);
  }
  docker(["stop", "--time", "15", worker]);
  const stopped = JSON.parse(docker(["inspect", "--format", "{{json .State}}", worker]));
  assert.equal(stopped.ExitCode, 0, "Worker must exit normally after SIGTERM");
  assert.equal(stopped.OOMKilled, false);
  const logs = docker(["logs", worker]);
  assert.match(logs, /received SIGTERM/);
  assert.match(logs, /graceful shutdown complete/);
  const finalState = fixtureState();
  assert.equal(finalState.deregistered, true, "Worker must remove its heartbeat at shutdown");
  assert.deepEqual(finalState.errors, []);
  console.log(
    "Worker container passed: non-root runtime, registration, polling, heartbeat, SIGTERM, deregistration, clean exit.",
  );
} catch (error) {
  console.error(docker(["logs", worker], { allowFailure: true }));
  console.error(error);
  process.exitCode = 1;
} finally {
  cleanup();
}
