import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

import { matchesDecision } from "./expectation.mjs";

const exec = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const temp = dirname(process.cwd());
const [, , results, mode, bombadil, chrome] = process.argv;
const origin = "http://127.0.0.1:55300";
const api = "http://127.0.0.1:55321";
const workspaceId = "b1b2c3d4-0001-4000-8000-000000000001";
const feedback = "Please clarify how the local fixture is verified.";
const listPath = "/w/acme-corp/sessions";
const email = "reviewer@example.invalid";
const cases = ["approve", "reject", "negative"];
const bootstrap = performance.now();
const status = JSON.parse(
  execFileSync("supabase", ["status", "-o", "json"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 15_000,
  }),
);
assert(
  status.API_URL === api && URL.canParse(status.DB_URL),
  "Expected disposable Supabase status",
);
const database = new URL(status.DB_URL);
assert(
  database.protocol === "postgresql:" &&
    database.hostname === "127.0.0.1" &&
    database.port === "55322",
  "Expected the scoped loopback database",
);
assert(status.ANON_KEY && status.SERVICE_ROLE_KEY);
const env = {
  ...process.env,
  NEXT_PUBLIC_APP_URL: origin,
  NEXT_PUBLIC_SUPABASE_URL: api,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
  SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
  WALLIE_CONTINUITY_SUPABASE_URL: api,
  WALLIE_CONTINUITY_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  WALLIE_SANDBOX_IMPL: "fake",
  WALLIE_ENCRYPTION_KEY: "00".repeat(32),
  WALLIE_REVIEW_WORKSPACE: workspaceId,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(temp, "fonts.cjs"),
};

async function sql(file, variables, readOnly) {
  const args = ["-XAtq", "-v", "ON_ERROR_STOP=1", "-f", join(source, file)];
  for (const [key, value] of Object.entries({ workspace_id: workspaceId, ...variables }))
    args.push("-v", `${key}=${value}`);
  try {
    const { stdout } = await exec("psql", args, {
      env: {
        ...process.env,
        PGHOST: database.hostname,
        PGPORT: database.port,
        PGUSER: decodeURIComponent(database.username),
        PGPASSWORD: decodeURIComponent(database.password),
        PGDATABASE: database.pathname.slice(1),
        PGOPTIONS: `-c statement_timeout=3000 -c default_transaction_read_only=${readOnly ? "on" : "off"}`,
      },
      timeout: 5_000,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${file} failed: ${error.stderr?.trim().slice(0, 400) || error.code}`);
  }
}

function start(args, childEnv, timeout) {
  const child = spawn(process.execPath, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => (output = (output + chunk).slice(-8000)));
  const outcome = new Promise((resolve) => {
    child.once("error", () => resolve("spawn error"));
    child.once("exit", (code, signal) => resolve(code ?? signal));
  });
  return { child, outcome, output: () => output };
}

async function authCookies() {
  const admin = createClient(api, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.data.properties?.hashed_token, "Could not issue the local dummy login");
  const cookies = [];
  const client = createServerClient(api, status.ANON_KEY, {
    cookies: { getAll: () => [], setAll: (values) => cookies.push(...values) },
  });
  const { data } = await client.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties.hashed_token,
  });
  assert(
    data.user?.email === email && data.session && cookies.length,
    "Local Auth bootstrap failed",
  );
  return {
    cookies: cookies.map(({ name, value, options }) => ({
      name,
      value,
      url: origin,
      httpOnly: options.httpOnly,
    })),
    privateValues: [
      status.ANON_KEY,
      status.SERVICE_ROLE_KEY,
      link.data.properties.hashed_token,
      data.session.access_token,
      data.session.refresh_token,
      ...cookies.map(({ value }) => value),
    ],
  };
}

async function run(name) {
  const started = performance.now();
  const decision = name === "reject" ? "reject" : "approve";
  const scenarioPath = join(temp, name);
  await mkdir(scenarioPath);
  const spec = join(scenarioPath, "specification.mjs");
  await copyFile(join(source, "specification.mjs"), spec);
  await copyFile(join(source, "expectation.mjs"), join(scenarioPath, "expectation.mjs"));
  const worker = start(
    ["node_modules/vitest/vitest.mjs", "run", "--config", join(source, "vitest.config.ts")],
    { ...env, WALLIE_REVIEW_WORKER_DIR: scenarioPath },
    125_000,
  );
  let context;
  let privateValues = [];
  try {
    const ready = join(scenarioPath, "ready.json");
    const deadline = performance.now() + 25_000;
    let number;
    while (!number) {
      number = await readFile(ready, "utf8").then(
        (text) => JSON.parse(text).number,
        () => null,
      );
      if (number) break;
      assert(
        worker.child.exitCode === null && performance.now() < deadline,
        "The local worker did not publish seeded Plan v1",
      );
      await delay(200);
    }
    const sessionPath = `${listPath}/${number}`;
    const read = async () => JSON.parse(await sql("observe.sql", { number, feedback }, true));
    const { identity, state: seed } = await read();
    assert(
      seed.phase === "awaiting_review" &&
        seed.stage === "Plan" &&
        seed.version === 1 &&
        seed.hasExactArtifact &&
        seed.jobs === 0 &&
        seed.runs === 1 &&
        seed.planRuns === 1,
      `Seed #${number} isn't a fresh exact Plan v1 review`,
    );
    const scenario = {
      origin,
      sessionPath,
      listPath,
      decision,
      feedback,
      decisionPath: `/api/sessions/${identity.id}/phase-action`,
      expectedNewRuns: name === "negative" ? 2 : 1,
    };
    await writeFile(join(scenarioPath, "scenario.json"), JSON.stringify(scenario));
    context = await chromium.launchPersistentContext(join(scenarioPath, "profile"), {
      executablePath: chrome,
      args: ["--remote-debugging-port=55301"],
      viewport: { width: 1280, height: 900 },
    });
    const credentials = await authCookies();
    privateValues = credentials.privateValues;
    await context.addCookies(credentials.cookies);
    await context.exposeBinding("__wallieReviewRead", async ({ frame }) => {
      const url = new URL(frame.url());
      if (url.origin !== origin || url.pathname !== sessionPath) return null;
      return (await read()).state;
    });
    await context.addInitScript(({ origin, sessionPath }) => {
      if (location.origin !== origin || location.pathname !== sessionPath) return;
      async function poll() {
        try {
          window.__wallieReview = await window.__wallieReviewRead();
        } catch {
          window.__wallieReview = null;
        }
        setTimeout(poll, 250);
      }
      void poll();
    }, scenario);
    const page = context.pages()[0];
    const navigation = await page.goto(origin + sessionPath, {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    });
    try {
      await page
        .getByRole("heading", { name: "Review Plan v1", exact: true })
        .waitFor({ timeout: 8000 });
    } catch {
      const path = new URL(page.url()).pathname;
      throw new Error(`Seed review isn't visible (HTTP ${navigation?.status()} at ${path})`);
    }
    await page.waitForFunction(
      () => {
        const button = document.querySelector('button[aria-label="Approve Plan"]');
        return button && !button.disabled && window.__wallieReview?.version === 1;
      },
      { timeout: 45_000 },
    );
    const trace = join(results, `${name}.bin`);
    const testStart = performance.now();
    let exit = 0;
    let driverError = "";
    try {
      await exec(
        bombadil,
        [
          "browser",
          "test-external",
          "--remote-debugger",
          "http://127.0.0.1:55301",
          "--time-limit",
          "22s",
          "--exit-on-violation",
          "--instrument-javascript=",
          "--width",
          "1280",
          "--height",
          "900",
          "--output-path",
          trace,
          origin + sessionPath,
          spec,
        ],
        { timeout: 32_000, maxBuffer: 2 * 1024 ** 2 },
      );
    } catch (error) {
      exit = error.code ?? error.signal ?? 1;
      driverError = safeOutput(error.stderr ?? "", privateValues).slice(-1200);
    }
    const seconds = ((performance.now() - testStart) / 1000).toFixed(1);
    const decoded = await exec(bombadil, ["trace", "--json", trace], { maxBuffer: 8 * 1024 ** 2 });
    assert(
      decoded.stdout.trim(),
      `${name}: Bombadil exited ${exit} without a trace state: ${driverError}`,
    );
    if (privateValues.some((value) => decoded.stdout.includes(value))) {
      await rm(trace, { force: true });
      throw new Error("Authentication data found in trace metadata; trace discarded");
    }
    const states = decoded.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).metadata);
    const actions = {};
    const violations = new Set();
    let reloadMatches = 0;
    let firstViolationState = null;
    for (const [index, state] of states.entries()) {
      const action =
        state.action?.Custom?.name ?? (typeof state.action === "string" ? state.action : null);
      if (action) actions[action] = (actions[action] ?? 0) + 1;
      for (const error of state.violations) {
        firstViolationState ??= index;
        violations.add(error.name);
      }
      if (
        state.snapshots.some(
          (snapshot) => snapshot.name === "review" && snapshot.value.matchesReload,
        )
      )
        reloadMatches++;
    }
    const { state: persisted } = await read();
    const accepted = persisted.approval + persisted.feedback;
    const summary = {
      exit,
      seconds,
      cycleSeconds: ((performance.now() - started) / 1000).toFixed(1),
      states: states.length,
      actions,
      reloadMatches,
      accepted,
      violations: [...violations],
      firstViolationState,
      persisted,
    };
    console.log(name, JSON.stringify(summary));
    await writeFile(join(results, `${name}.json`), JSON.stringify(summary, null, 2) + "\n");
    assert.equal(exit, name === "negative" ? 2 : 0, `${name}: unexpected Bombadil exit`);
    assert.deepEqual([...violations], name === "negative" ? ["exactDecision"] : []);
    assert(
      actions[decision === "reject" ? "queueRerun" : "approvePlanV1"] && accepted === 1,
      `${name}: no exact browser review accepted once`,
    );
    assert.equal(await worker.outcome, 0, `${name}: the deterministic worker did not complete`);
    assert(
      reloadMatches > 0 || name === "negative",
      `${name}: no matching review after post-decision reload`,
    );
    assert(
      persisted.finishedJobs === 1 && matchesDecision(persisted, decision, 1),
      `${name}: the scoped database did not record exactly the expected transition`,
    );
  } catch (error) {
    console.error(safeOutput(worker.output(), privateValues));
    throw error;
  } finally {
    worker.child.kill();
    await context?.close();
  }
}

function safeOutput(output, extra = []) {
  for (const value of [status.ANON_KEY, status.SERVICE_ROLE_KEY, ...extra])
    if (value) output = output.replaceAll(value, "[fixture auth]");
  return output.replace(
    /(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|base64-[\w-]+|sb_(?:secret|publishable)_[\w-]+)/g,
    "[fixture auth]",
  );
}

await writeFile(
  env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES,
  'module.exports = new Proxy({}, {get: () => "@font-face { font-family: Fixture; src: local(Arial); }"});\n',
);
await sql("seed.sql", {}, false);
const web = start(
  ["node_modules/next/dist/bin/next", "dev", "--webpack", "-H", "127.0.0.1", "-p", "55300"],
  env,
);
try {
  const deadline = performance.now() + 45_000;
  while (true) {
    if (
      await fetch(origin + "/site.webmanifest", { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    assert(performance.now() < deadline, "Local Wallie server did not become ready");
    await delay(200);
  }
  console.log(`Wallie listener ready in ${((performance.now() - bootstrap) / 1000).toFixed(1)}s`);
  for (const name of mode === "all" ? cases : [mode]) await run(name);
  if (mode === "negative") process.exitCode = 2;
} catch (error) {
  console.error(safeOutput(web.output()));
  throw error;
} finally {
  web.child.kill();
}
