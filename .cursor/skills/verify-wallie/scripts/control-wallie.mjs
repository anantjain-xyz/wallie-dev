#!/usr/bin/env node
/**
 * control-wallie — verification harness for the Wallie Next.js web UI.
 * Invocations are documented in .cursor/skills/verify-wallie/SKILL.md.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const VERIFY_ROOT = join(REPO_ROOT, ".wallie", "verify");
const CURRENT_RUN_PATH = join(VERIFY_ROOT, "current-run.json");

const DEFAULT_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function usage(exitCode = 1) {
  process.stderr.write(`usage:
  control-wallie.mjs launch [--port <n>] [--worker] [--manage-supabase] [--skip-ready-wait]
  control-wallie.mjs doctor
  control-wallie.mjs stop
  control-wallie.mjs sign-in [--destination <path>]
  control-wallie.mjs browser goto <path-or-url>
  control-wallie.mjs browser click --role <role> --name <name>
  control-wallie.mjs browser fill --role <role> --name <name> --value <value>
  control-wallie.mjs browser press --key <key>
  control-wallie.mjs browser screenshot --path <file>
  control-wallie.mjs browser snapshot --aria --path <file>
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadEnvLocal() {
  const envPath = join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function readRun() {
  if (!fs.existsSync(CURRENT_RUN_PATH)) {
    throw new Error(`No active run at ${CURRENT_RUN_PATH}. Run launch first.`);
  }
  return JSON.parse(fs.readFileSync(CURRENT_RUN_PATH, "utf8"));
}

function writeRun(run) {
  fs.mkdirSync(VERIFY_ROOT, { recursive: true });
  fs.mkdirSync(run.evidenceDir, { recursive: true });
  fs.writeFileSync(join(run.evidenceDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(CURRENT_RUN_PATH, `${JSON.stringify(run, null, 2)}\n`);
}

function updateRun(patch) {
  const run = { ...readRun(), ...patch };
  writeRun(run);
  return run;
}

function evidencePath(run, relativePath) {
  const target = isAbsolute(relativePath)
    ? relativePath
    : join(run.evidenceDir, relativePath);
  fs.mkdirSync(dirname(target), { recursive: true });
  return target;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const text = await response.text();
    return { status: response.status, text, url: response.url };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const { status, text } = await fetchText(baseUrl, 3000);
      if (
        status === 200 &&
        (text.includes("Sign in to Wallie") ||
          text.includes("Workspace navigation") ||
          text.includes("Wallie"))
      ) {
        return;
      }
      lastError = `status=${status} bodyMarkers=missing`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl} (${lastError})`);
}

function spawnLogged(command, args, logPath, extraEnv = {}) {
  fs.mkdirSync(dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "");
  const out = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...loadEnvLocal(), ...extraEnv },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

async function cmdLaunch(args) {
  const port = String(args.port ?? process.env.WALLIE_VERIFY_PORT ?? "3000");
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const evidenceDir = join(VERIFY_ROOT, runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  if (!fs.existsSync(join(REPO_ROOT, ".env.local"))) {
    throw new Error(
      ".env.local missing. Copy .env.example and fill Supabase + WALLIE_ENCRYPTION_KEY.",
    );
  }

  // Stop a previous control-wallie-owned Next if present.
  if (fs.existsSync(CURRENT_RUN_PATH)) {
    try {
      await cmdStop({ quiet: true });
    } catch {
      /* no prior run */
    }
  }

  const pids = {};
  if (args["manage-supabase"]) {
    pids.supabaseStart = spawnLogged(
      "supabase",
      ["start"],
      join(evidenceDir, "supabase-start.log"),
    );
    await delay(1000);
  }

  const nextPid = spawnLogged(
    "pnpm",
    ["exec", "next", "dev", "--port", port, "--hostname", "127.0.0.1"],
    join(evidenceDir, "next.log"),
    {
      NEXT_PUBLIC_APP_URL: baseUrl,
      PORT: port,
    },
  );
  pids.next = nextPid;

  if (args.worker) {
    pids.worker = spawnLogged("pnpm", ["worker"], join(evidenceDir, "worker.log"));
  }

  const run = {
    runId,
    evidenceDir,
    baseUrl,
    port,
    pids,
    lastUrl: baseUrl,
    startedAt: new Date().toISOString(),
    manageSupabase: Boolean(args["manage-supabase"]),
  };
  writeRun(run);

  if (!args["skip-ready-wait"]) {
    await waitForReady(baseUrl);
  }

  process.stdout.write(
    `ready baseUrl=${baseUrl} evidenceDir=${evidenceDir} nextPid=${nextPid}\n`,
  );
}

async function cmdDoctor() {
  const run = readRun();
  const problems = [];

  if (!pidAlive(run.pids?.next)) {
    problems.push(`next pid ${run.pids?.next} is not running`);
  }

  try {
    const home = await fetchText(run.baseUrl, 5000);
    if (home.status !== 200) problems.push(`GET / -> ${home.status}`);
    const okHome =
      home.text.includes("Sign in to Wallie") ||
      home.text.includes("Workspace navigation") ||
      home.text.includes("Wallie");
    if (!okHome) problems.push("GET / missing Wallie identity markers");
  } catch (error) {
    problems.push(`GET / failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const login = await fetchText(`${run.baseUrl}/login`, 5000);
    if (login.status === 200) {
      if (!login.text.includes("Sign in to Wallie")) {
        problems.push("GET /login missing Sign in to Wallie");
      }
      if (!login.text.includes("Work email")) {
        problems.push("GET /login missing Work email");
      }
    }
  } catch (error) {
    problems.push(`GET /login failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (problems.length) {
    process.stderr.write(`doctor FAIL\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `doctor OK baseUrl=${run.baseUrl} evidenceDir=${run.evidenceDir} nextPid=${run.pids.next}\n`,
  );
}

function killPidTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function cmdStop(options = {}) {
  const run = readRun();
  killPidTree(run.pids?.worker);
  killPidTree(run.pids?.next);
  await delay(800);
  for (const key of ["next", "worker"]) {
    const pid = run.pids?.[key];
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  run.stoppedAt = new Date().toISOString();
  fs.writeFileSync(join(run.evidenceDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  if (fs.existsSync(CURRENT_RUN_PATH)) fs.unlinkSync(CURRENT_RUN_PATH);
  if (!options.quiet) {
    process.stdout.write(`stopped evidenceDir=${run.evidenceDir} (evidence retained)\n`);
  }
}

async function withBrowser(run, fn) {
  const { chromium } = await import("playwright");
  const userDataDir = join(run.evidenceDir, "browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    return await fn(page, context);
  } finally {
    const lastUrl = page.url();
    if (lastUrl && lastUrl !== "about:blank") {
      updateRun({ lastUrl });
    }
    await context.close();
  }
}

async function ensurePage(page, run) {
  const current = page.url();
  if (current === "about:blank" || current === "") {
    const target = run.lastUrl || run.baseUrl;
    await page.goto(target, { waitUntil: "domcontentloaded" });
  }
}

function locatorFor(page, role, name) {
  if (!role || name === undefined) {
    throw new Error("browser actions require --role and --name");
  }
  const nameOption =
    typeof name === "string" && name.startsWith("/") && name.endsWith("/")
      ? new RegExp(name.slice(1, -1))
      : name;
  return page.getByRole(role, { name: nameOption });
}

async function cmdBrowser(args) {
  const run = readRun();
  const action = args._[0];
  if (!action) usage();

  await withBrowser(run, async (page) => {
    if (action === "goto") {
      const target = args._[1];
      if (!target) usage();
      const url = target.startsWith("http") ? target : new URL(target, run.baseUrl).toString();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      process.stdout.write(`goto ${page.url()}\n`);
      return;
    }

    await ensurePage(page, run);

    if (action === "click") {
      await locatorFor(page, args.role, args.name).first().click();
      await page.waitForLoadState("domcontentloaded");
      process.stdout.write(`click role=${args.role} name=${args.name} url=${page.url()}\n`);
      return;
    }

    if (action === "fill") {
      if (args.value === undefined) throw new Error("--value required");
      await locatorFor(page, args.role, args.name).first().fill(String(args.value));
      process.stdout.write(`fill role=${args.role} name=${args.name}\n`);
      return;
    }

    if (action === "press") {
      if (!args.key) throw new Error("--key required");
      await page.keyboard.press(String(args.key));
      process.stdout.write(`press key=${args.key}\n`);
      return;
    }

    if (action === "screenshot") {
      if (!args.path) throw new Error("--path required");
      const path = evidencePath(run, String(args.path));
      await page.screenshot({ path, fullPage: true });
      process.stdout.write(`screenshot ${path}\n`);
      return;
    }

    if (action === "snapshot") {
      if (!args.path) throw new Error("--path required");
      const path = evidencePath(run, String(args.path));
      const aria = await page.locator("body").ariaSnapshot();
      fs.writeFileSync(path, `${aria}\n`);
      process.stdout.write(`snapshot ${path}\n`);
      return;
    }

    usage();
  });
}

async function cmdSignIn(args) {
  const run = readRun();
  const destination = String(args.destination ?? "/w/acme-corp/sessions");
  const env = { ...loadEnvLocal(), ...process.env };
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const serviceKey = env.SUPABASE_SECRET_KEY ?? DEFAULT_SERVICE_ROLE_KEY;
  const allowlistedRedirect = `http://localhost:3000/auth/confirm?next=${encodeURIComponent(destination)}`;

  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(allowlistedRedirect)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "magiclink",
        email: "anant@example.com",
        options: { redirectTo: allowlistedRedirect },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`generate_link failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const hashedToken = data.hashed_token ?? data.properties?.hashed_token;
  if (!hashedToken) {
    throw new Error(`generate_link missing hashed_token: ${JSON.stringify(data)}`);
  }

  const confirmUrl =
    `${run.baseUrl}/auth/confirm?next=${encodeURIComponent(destination)}` +
    `&token_hash=${encodeURIComponent(hashedToken)}&type=email`;

  await withBrowser(run, async (page) => {
    await page.goto(confirmUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/w\/acme-corp/, { timeout: 15_000 });
    process.stdout.write(`signed-in url=${page.url()}\n`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage(0);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  try {
    if (command === "launch") await cmdLaunch(args);
    else if (command === "doctor") await cmdDoctor();
    else if (command === "stop") await cmdStop();
    else if (command === "sign-in") await cmdSignIn(args);
    else if (command === "browser") await cmdBrowser(args);
    else usage();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
