#!/usr/bin/env node
/**
 * CI-equivalent flake probe for the regression suite.
 * Runs the Playwright regression specs N times (default 50) against a
 * production build and fails if the flake rate is >= 1%.
 */
import { spawnSync } from "node:child_process";

const runs = Number(process.env.REGRESSION_FLAKE_RUNS ?? 50);
const results = [];

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env, CI: "1" },
    encoding: "utf8",
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function waitForSupabase(timeoutMs = 60_000) {
  const started = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:54321";
  while (Date.now() - started < timeoutMs) {
    const result = spawnSync(
      "curl",
      ["-fsS", "-o", "/dev/null", "-m", "2", `${url}/auth/v1/health`],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`Supabase auth health check failed for ${url}`);
}

console.log(`Building production app once for ${runs} CI-equivalent runs…`);
if (run("pnpm", ["build"]) !== 0) process.exit(1);
waitForSupabase();

for (let index = 1; index <= runs; index += 1) {
  console.log(`\n=== regression flake run ${index}/${runs} ===`);
  waitForSupabase();
  const status = run("pnpm", ["exec", "playwright", "test", "e2e/regression"], {
    PLAYWRIGHT_HOST: process.env.PLAYWRIGHT_HOST ?? "localhost",
    PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? "3100",
  });
  results.push(status === 0);
  if (status !== 0) {
    console.error(`Run ${index} failed`);
  }
}

const failures = results.filter((ok) => !ok).length;
const flakeRate = failures / results.length;
console.log(
  JSON.stringify(
    {
      failures,
      flakeRate,
      runs: results.length,
      passes: results.length - failures,
    },
    null,
    2,
  ),
);

if (flakeRate >= 0.01) {
  console.error(`Flake rate ${(flakeRate * 100).toFixed(2)}% is not below 1%`);
  process.exit(1);
}

console.log(`Flake rate ${(flakeRate * 100).toFixed(2)}% is below 1%`);
