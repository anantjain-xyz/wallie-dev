#!/usr/bin/env node
/**
 * control-wallie — verification harness for the Wallie Next.js web UI.
 * Invocations are documented in .cursor/skills/verify-wallie/SKILL.md.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../../..");
const VERIFY_ROOT = join(REPO_ROOT, ".wallie", "verify");
const CURRENT_RUN_PATH = join(VERIFY_ROOT, "current-run.json");
const SCRIPT_PATH = __filename;

const DEFAULT_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function usage(exitCode = 1) {
  process.stderr.write(`usage:
  control-wallie.mjs launch [--port <n>] [--worker] [--manage-supabase] [--skip-ready-wait]
  control-wallie.mjs doctor
  control-wallie.mjs stop
  control-wallie.mjs sign-in [--destination <path>]
  control-wallie.mjs browser goto <path-or-url>
  control-wallie.mjs browser click --role <role> --name <name> [--wait-for-url <re>] [--wait-for-text <text>] [--wait-hidden] [--screenshot <file>]
  control-wallie.mjs browser fill --role <role> --name <name> --value <value> [--submit] [--wait-for-url <re>] [--wait-for-text <text>] [--screenshot <file>] [--snapshot-aria <file>]
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
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}

function mergedEnv(extra = {}) {
  return { ...process.env, ...loadEnvLocal(), ...extra };
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
  if (relativePath == null || String(relativePath).trim() === "") {
    throw new Error("evidence path is required");
  }
  const evidenceRoot = resolve(run.evidenceDir);
  const target = resolve(evidenceRoot, String(relativePath));
  const prefix = evidenceRoot.endsWith("/") ? evidenceRoot : `${evidenceRoot}/`;
  if (target !== evidenceRoot && !target.startsWith(prefix)) {
    throw new Error(`evidence path escapes run directory: ${relativePath}`);
  }
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

function readLinuxPidIdentity(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const starttime = afterComm[19] ?? "";
    if (!cmdline && !starttime) return null;
    return { pid, cmdline, starttime };
  } catch {
    return null;
  }
}

function readPsPidIdentity(pid) {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    return { pid, cmdline: out, starttime: out };
  } catch {
    return null;
  }
}

function readPidIdentity(pid) {
  if (!pid) return null;
  return readLinuxPidIdentity(pid) ?? readPsPidIdentity(pid);
}

function captureIdentities(pids) {
  const pidIdentities = {};
  for (const [key, pid] of Object.entries(pids ?? {})) {
    const identity = readPidIdentity(pid);
    if (identity) pidIdentities[key] = identity;
  }
  return pidIdentities;
}

function pidStillOurs(pid, identity) {
  if (!pid || !identity) return false;
  const current = readPidIdentity(pid);
  if (!current) return false;
  return current.starttime === identity.starttime && current.cmdline === identity.cmdline;
}

function recordedPidAlive(run, key) {
  return pidStillOurs(run.pids?.[key], run.pidIdentities?.[key]);
}

function captureLiveDescendants(pid, identity) {
  if (!pidStillOurs(pid, identity)) return [];
  const descendants = [];
  for (const child of collectProcessTree(pid)) {
    if (child === Number(pid)) continue;
    const current = readPidIdentity(child);
    if (current) descendants.push(current);
  }
  return descendants;
}

function killVerifiedPid(pid, identity, signal) {
  if (!pidStillOurs(pid, identity)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function signInFailedUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return true;
    if (url.pathname === "/auth/confirm" || url.pathname.startsWith("/auth/confirm/")) {
      return true;
    }
    if (url.searchParams.has("error")) return true;
  } catch {
    return /\/login(?:\/|\?|#|$)|\/auth\/confirm/.test(String(urlString));
  }
  return false;
}

function destinationWaitPattern(destinationPath) {
  const raw = String(destinationPath).startsWith("/")
    ? String(destinationPath)
    : `/${destinationPath}`;
  const path = raw.replace(/\/+$/, "") || "/";
  if (path === "/") {
    // confirm/route.ts replaces "/" with authenticated home (/w/<slug> or /onboarding/...).
    return "^https?:\\/\\/[^/]+(\\/?([?#]|$)|\\/w\\/[^/?#]+|\\/onboarding(?:\\/|$))";
  }
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^https?:\\/\\/[^/]+${escaped}(?:\\/|[?#]|$)`;
}

function collectProcessTreeFromProc(rootPid) {
  const root = Number(rootPid);
  const childrenByPpid = new Map();
  try {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
        const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
        if (!ppidMatch) continue;
        const ppid = Number(ppidMatch[1]);
        const list = childrenByPpid.get(ppid);
        if (list) list.push(Number(name));
        else childrenByPpid.set(ppid, [Number(name)]);
      } catch {
        /* process exited */
      }
    }
  } catch {
    return new Set();
  }
  return walkPidTree(root, childrenByPpid);
}

function collectProcessTreeFromPs(rootPid) {
  const root = Number(rootPid);
  const childrenByPpid = new Map();
  try {
    const out = execFileSync("ps", ["-axo", "pid=", "-o", "ppid="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      const list = childrenByPpid.get(ppid);
      if (list) list.push(pid);
      else childrenByPpid.set(ppid, [pid]);
    }
  } catch {
    return new Set([root]);
  }
  return walkPidTree(root, childrenByPpid);
}

function walkPidTree(root, childrenByPpid) {
  const tree = new Set();
  const queue = [Number(root)];
  while (queue.length) {
    const pid = queue.pop();
    if (tree.has(pid)) continue;
    tree.add(pid);
    const children = childrenByPpid.get(pid);
    if (children) queue.push(...children);
  }
  return tree;
}

function collectProcessTree(rootPid) {
  const fromProc = collectProcessTreeFromProc(rootPid);
  if (fromProc.size > 1) return fromProc;
  const fromPs = collectProcessTreeFromPs(rootPid);
  return fromPs.size > 0 ? fromPs : fromProc.size > 0 ? fromProc : new Set([Number(rootPid)]);
}

function pidsListeningOnPort(port) {
  const pids = new Set();
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
    const localPort = new RegExp(`[:\\]]${port}\\s`);
    for (const line of out.split("\n")) {
      if (!localPort.test(`${line} `)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) {
        pids.add(Number(match[1]));
      }
    }
  } catch {
    /* ss unavailable */
  }
  return pids;
}

function nextLogConfirmsBind(logPath, port) {
  if (!logPath || !fs.existsSync(logPath)) return false;
  const text = fs.readFileSync(logPath, "utf8");
  return new RegExp(`(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):${port}\\b`).test(text);
}

function spawnedServerOwnsPort(pid, port, logPath) {
  const listeners = pidsListeningOnPort(port);
  if (listeners.size > 0) {
    const tree = collectProcessTree(pid);
    for (const listener of listeners) {
      if (tree.has(listener)) return true;
    }
    return false;
  }
  return nextLogConfirmsBind(logPath, port);
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

function tailLog(logPath, maxChars = 2000) {
  if (!fs.existsSync(logPath)) return "";
  const text = fs.readFileSync(logPath, "utf8");
  return text.slice(-maxChars);
}

async function waitForReady(baseUrl, { timeoutMs = 60_000, pid, logPath, port } = {}) {
  const listenPort = String(port ?? new URL(baseUrl).port ?? "3000");
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    if (pid && !pidAlive(pid)) {
      const logTail = logPath ? tailLog(logPath) : "";
      throw new Error(
        `Next process ${pid} exited before ${baseUrl} became ready.${logTail ? `\n${logTail}` : ""}`,
      );
    }
    if (logPath && fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, "utf8");
      if (/EADDRINUSE|address already in use/i.test(log)) {
        throw new Error(
          `Next failed to bind ${baseUrl}: address already in use.\n${tailLog(logPath)}`,
        );
      }
    }
    if (pid && !spawnedServerOwnsPort(pid, listenPort, logPath)) {
      const listeners = [...pidsListeningOnPort(listenPort)];
      lastError = `port ${listenPort} is not owned by Next pid ${pid} (listeners=${
        listeners.join(",") || "none"
      })`;
      await delay(500);
      continue;
    }
    try {
      const { status, text } = await fetchText(baseUrl, 3000);
      if (
        status === 200 &&
        (text.includes("Sign in to Wallie") ||
          text.includes("Workspace navigation") ||
          text.includes("Wallie"))
      ) {
        if (pid && !pidAlive(pid)) {
          throw new Error(`Next process ${pid} exited after ${baseUrl} answered`);
        }
        if (pid && !spawnedServerOwnsPort(pid, listenPort, logPath)) {
          lastError = `HTTP ready but pid ${pid} does not own port ${listenPort}`;
          await delay(500);
          continue;
        }
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
    env: mergedEnv(extraEnv),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

function spawnLoggedWait(command, args, logPath, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    fs.mkdirSync(dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "");
    const out = fs.openSync(logPath, "a");
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: mergedEnv(extraEnv),
      stdio: ["ignore", out, out],
    });
    child.on("error", (error) => {
      try {
        fs.closeSync(out);
      } catch {
        /* ignore */
      }
      reject(error);
    });
    child.on("close", (code) => {
      try {
        fs.closeSync(out);
      } catch {
        /* ignore */
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited ${code}. See ${logPath}\n${tailLog(logPath)}`,
        ),
      );
    });
  });
}

async function waitForBrowserSidecar(pid, logPath, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    if (pid && !pidAlive(pid)) {
      throw new Error(`browser sidecar ${pid} exited before it became ready.\n${tailLog(logPath)}`);
    }
    try {
      const current = readRun();
      if (current.browserPort) {
        const health = await fetchText(`http://127.0.0.1:${current.browserPort}/health`, 1000);
        if (health.status === 200) return current;
        lastError = `health ${health.status}`;
      } else {
        lastError = "browserPort missing";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for browser sidecar (${lastError})`);
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

  if (fs.existsSync(CURRENT_RUN_PATH)) {
    await cmdStop({ quiet: true });
  }

  const manageSupabase = Boolean(args["manage-supabase"]);
  if (manageSupabase) {
    writeRun({
      runId,
      evidenceDir,
      baseUrl,
      port,
      pids: {},
      lastUrl: baseUrl,
      startedAt: new Date().toISOString(),
      manageSupabase: true,
    });
    try {
      await spawnLoggedWait("supabase", ["start"], join(evidenceDir, "supabase-start.log"));
      const auth = await fetchText("http://127.0.0.1:54321/auth/v1/health", 5000);
      if (auth.status !== 200) {
        throw new Error(`Supabase Auth health returned ${auth.status}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await cmdStop({ quiet: true });
      } catch (stopError) {
        throw new Error(
          `Supabase start/probe failed (${detail}); cleanup also failed (${
            stopError instanceof Error ? stopError.message : String(stopError)
          })`,
        );
      }
      throw new Error(`Supabase start/probe failed (${detail})`);
    }
  }

  const nextLog = join(evidenceDir, "next.log");
  const pids = {};
  const nextPid = spawnLogged(
    "pnpm",
    ["exec", "next", "dev", "--port", port, "--hostname", "127.0.0.1"],
    nextLog,
    {
      NEXT_PUBLIC_APP_URL: baseUrl,
      PORT: port,
    },
  );
  pids.next = nextPid;

  if (args.worker) {
    pids.worker = spawnLogged("pnpm", ["worker"], join(evidenceDir, "worker.log"));
  }

  const browserToken = crypto.randomBytes(16).toString("hex");
  const run = {
    runId,
    evidenceDir,
    baseUrl,
    port,
    pids,
    pidIdentities: captureIdentities(pids),
    lastUrl: baseUrl,
    startedAt: new Date().toISOString(),
    manageSupabase,
    browserToken,
  };
  writeRun(run);

  const browserLog = join(evidenceDir, "browser.log");
  pids.browser = spawnLogged(process.execPath, [SCRIPT_PATH, "_browser-serve"], browserLog);
  updateRun({ pids, pidIdentities: captureIdentities(pids) });

  try {
    await waitForBrowserSidecar(pids.browser, browserLog);
    if (!args["skip-ready-wait"]) {
      await waitForReady(baseUrl, { pid: nextPid, logPath: nextLog, port });
    }
  } catch (error) {
    await cmdStop({ quiet: true }).catch(() => undefined);
    throw error;
  }

  process.stdout.write(`ready baseUrl=${baseUrl} evidenceDir=${evidenceDir} nextPid=${nextPid}\n`);
}

async function cmdDoctor() {
  const run = readRun();
  const problems = [];

  if (!recordedPidAlive(run, "next")) {
    problems.push(`next pid ${run.pids?.next} is not running`);
  } else if (
    run.port &&
    !spawnedServerOwnsPort(run.pids.next, run.port, join(run.evidenceDir, "next.log"))
  ) {
    problems.push(`next pid ${run.pids.next} does not own port ${run.port}`);
  }
  if (run.pids?.worker != null && !recordedPidAlive(run, "worker")) {
    problems.push(`worker pid ${run.pids.worker} is not running`);
  }
  if (run.pids?.browser != null && !recordedPidAlive(run, "browser")) {
    problems.push(`browser sidecar pid ${run.pids.browser} is not running`);
  }

  try {
    const home = await fetchText(run.baseUrl, 5000);
    if (home.status !== 200) problems.push(`GET / -> ${home.status}`);
    const okHome =
      home.text.includes("Sign in to Wallie") ||
      home.text.includes("Workspace navigation") ||
      home.text.includes("Wallie");
    if (home.status === 200 && !okHome) problems.push("GET / missing Wallie identity markers");
  } catch (error) {
    problems.push(`GET / failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const login = await fetchText(`${run.baseUrl}/login`, 5000);
    if (login.status !== 200) {
      problems.push(`GET /login -> ${login.status}`);
    } else {
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

  if (run.browserPort) {
    try {
      const health = await fetchText(`http://127.0.0.1:${run.browserPort}/health`, 2000);
      if (health.status !== 200) problems.push(`browser sidecar health -> ${health.status}`);
    } catch (error) {
      problems.push(
        `browser sidecar is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (run.manageSupabase) {
    try {
      const auth = await fetchText("http://127.0.0.1:54321/auth/v1/health", 5000);
      if (auth.status !== 200) {
        problems.push(`Supabase Auth health -> ${auth.status}`);
      }
    } catch (error) {
      problems.push(
        `Supabase Auth is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (problems.length) {
    process.stderr.write(`doctor FAIL\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `doctor OK baseUrl=${run.baseUrl} evidenceDir=${run.evidenceDir} nextPid=${run.pids.next}\n`,
  );
}

async function cmdStop(options = {}) {
  const run = readRun();
  const liveDescendants = {
    browser: captureLiveDescendants(run.pids?.browser, run.pidIdentities?.browser),
    worker: captureLiveDescendants(run.pids?.worker, run.pidIdentities?.worker),
    next: captureLiveDescendants(run.pids?.next, run.pidIdentities?.next),
  };
  killVerifiedPid(run.pids?.browser, run.pidIdentities?.browser, "SIGTERM");
  killVerifiedPid(run.pids?.worker, run.pidIdentities?.worker, "SIGTERM");
  killVerifiedPid(run.pids?.next, run.pidIdentities?.next, "SIGTERM");
  await delay(800);
  for (const key of ["browser", "next", "worker"]) {
    killVerifiedPid(run.pids?.[key], run.pidIdentities?.[key], "SIGKILL");
    for (const descendant of liveDescendants[key] ?? []) {
      if (!pidStillOurs(descendant.pid, descendant)) continue;
      try {
        process.kill(descendant.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  let supabaseStopError = null;
  if (run.manageSupabase) {
    try {
      await spawnLoggedWait("supabase", ["stop"], join(run.evidenceDir, "supabase-stop.log"));
    } catch (error) {
      supabaseStopError = error;
    }
  }

  run.stoppedAt = new Date().toISOString();
  fs.writeFileSync(join(run.evidenceDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  if (supabaseStopError) {
    writeRun(run);
    throw new Error(
      `supabase stop failed: ${
        supabaseStopError instanceof Error ? supabaseStopError.message : String(supabaseStopError)
      }`,
    );
  }
  if (fs.existsSync(CURRENT_RUN_PATH)) fs.unlinkSync(CURRENT_RUN_PATH);
  if (!options.quiet) {
    process.stdout.write(`stopped evidenceDir=${run.evidenceDir} (evidence retained)\n`);
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

async function ensurePage(page, run) {
  const current = page.url();
  if (current === "about:blank" || current === "") {
    const target = run.lastUrl || run.baseUrl;
    await page.goto(target, { waitUntil: "domcontentloaded" });
  }
}

async function executeBrowserAction(page, run, args) {
  const action = args._[0];
  const lines = [];
  const log = (message) => {
    lines.push(message);
  };

  if (action === "goto") {
    const target = args._[1] ?? args.target;
    if (target == null || target === "") {
      throw new Error("browser goto requires a path or URL");
    }
    const url = String(target).startsWith("http")
      ? String(target)
      : new URL(String(target), run.baseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (args.waitForUrl) {
      await page.waitForURL(new RegExp(String(args.waitForUrl)), { timeout: 15_000 });
    }
    log(`goto ${page.url()}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  await ensurePage(page, run);

  if (action === "click") {
    const locator = locatorFor(page, args.role, args.name).first();
    const beforeUrl = page.url();
    const href = await locator.getAttribute("href");
    await Promise.all([
      href && href.startsWith("/")
        ? page.waitForURL(
            (url) => {
              const next = url.toString();
              return next !== beforeUrl && next.includes(href.split("?")[0]);
            },
            { timeout: 15_000 },
          )
        : page.waitForLoadState("domcontentloaded"),
      locator.click(),
    ]);
    if (args["wait-for-url"]) {
      await page.waitForURL(new RegExp(String(args["wait-for-url"])), { timeout: 15_000 });
    }
    if (args["wait-for-text"]) {
      await page
        .getByText(String(args["wait-for-text"]))
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    }
    if (args["wait-hidden"]) {
      await locator.waitFor({ state: "hidden", timeout: 15_000 });
    }
    if (args.screenshot) {
      const path = evidencePath(run, String(args.screenshot));
      await page.screenshot({ path, fullPage: true });
      log(`screenshot ${path}`);
    }
    log(`click role=${args.role} name=${args.name} url=${page.url()}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  if (action === "fill") {
    if (args.value === undefined) throw new Error("--value required");
    const locator = locatorFor(page, args.role, args.name).first();
    await locator.fill(String(args.value));
    if (args.submit) {
      const beforeUrl = page.url();
      const submitted = String(args.value);
      await locator.press("Enter");
      let settled = false;
      try {
        await page.waitForURL(
          (url) => {
            const href = url.toString();
            if (href === beforeUrl) return false;
            try {
              const parsed = new URL(href);
              const q = parsed.searchParams.get("q");
              if (q != null && q === submitted) return true;
              return (
                parsed.pathname !== new URL(beforeUrl).pathname ||
                parsed.search !== new URL(beforeUrl).search
              );
            } catch {
              return href !== beforeUrl;
            }
          },
          { timeout: 15_000 },
        );
        settled = true;
      } catch {
        try {
          await page.getByRole("alert").first().waitFor({ state: "visible", timeout: 5_000 });
          settled = true;
        } catch {
          settled = false;
        }
      }
      if (!settled) {
        throw new Error(
          `fill --submit did not change the URL or show an alert (still ${page.url()})`,
        );
      }
    }
    if (args["wait-for-url"]) {
      await page.waitForURL(new RegExp(String(args["wait-for-url"])), { timeout: 15_000 });
    }
    if (args["wait-for-text"]) {
      await page
        .getByText(String(args["wait-for-text"]))
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    }
    if (args.screenshot) {
      const path = evidencePath(run, String(args.screenshot));
      await page.screenshot({ path, fullPage: true });
      log(`screenshot ${path}`);
    }
    if (args["snapshot-aria"]) {
      const path = evidencePath(run, String(args["snapshot-aria"]));
      const aria = await page.locator("body").ariaSnapshot();
      fs.writeFileSync(path, `${aria}\n`);
      log(`snapshot ${path}`);
    }
    log(`fill role=${args.role} name=${args.name}${args.submit ? " submit=Enter" : ""}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  if (action === "press") {
    if (!args.key) throw new Error("--key required");
    await page.keyboard.press(String(args.key));
    log(`press key=${args.key}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  if (action === "screenshot") {
    if (!args.path) throw new Error("--path required");
    const path = evidencePath(run, String(args.path));
    await page.screenshot({ path, fullPage: true });
    log(`screenshot ${path}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  if (action === "snapshot") {
    if (!args.path) throw new Error("--path required");
    const path = evidencePath(run, String(args.path));
    const aria = await page.locator("body").ariaSnapshot();
    fs.writeFileSync(path, `${aria}\n`);
    log(`snapshot ${path}`);
    return { stdout: `${lines.join("\n")}\n`, lastUrl: page.url() };
  }

  throw new Error(`unknown browser action: ${action ?? "(missing)"}`);
}

function readHttpBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function cmdBrowserServe() {
  const initial = readRun();
  const { chromium } = await import("@playwright/test");
  const userDataDir = join(initial.evidenceDir, "browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const server = http.createServer(async (req, res) => {
    const fail = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };

    if (req.method === "GET" && req.url === "/health") {
      const browser = context.browser();
      if (page.isClosed() || !browser?.isConnected()) {
        fail(503, "browser disconnected");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: page.url() }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/rpc") {
      fail(404, "not found");
      return;
    }

    const run = readRun();
    const expected = `Bearer ${run.browserToken}`;
    if (req.headers.authorization !== expected) {
      fail(401, "unauthorized");
      return;
    }

    try {
      const body = JSON.parse((await readHttpBody(req)) || "{}");
      const result = await executeBrowserAction(page, run, body);
      if (result.lastUrl && result.lastUrl !== "about:blank") {
        updateRun({ lastUrl: result.lastUrl });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      fail(500, error instanceof Error ? error.message : String(error));
    }
  });

  const shutdown = async () => {
    await context.close().catch(() => undefined);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const browserPort = typeof address === "object" && address ? address.port : 0;
    updateRun({ browserPort });
  });
}

async function browserRpc(args) {
  const run = readRun();
  if (!run.browserPort) {
    throw new Error("browser sidecar is not running; relaunch with control-wallie launch");
  }
  const response = await fetch(`http://127.0.0.1:${run.browserPort}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${run.browserToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `browser rpc ${response.status}`);
  }
  if (data.stdout) process.stdout.write(data.stdout);
  return data;
}

async function cmdBrowser(args) {
  if (!args._[0]) usage();
  await browserRpc(args);
}

async function cmdSignIn(args) {
  const run = readRun();
  const destination = String(args.destination ?? "/w/acme-corp/sessions");
  const env = mergedEnv();
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

  const destinationPath = destination.startsWith("http")
    ? new URL(destination).pathname
    : destination;
  const destinationPattern = destinationWaitPattern(destinationPath);

  const result = await browserRpc({
    _: ["goto", confirmUrl],
    waitForUrl: destinationPattern,
  });
  const landed = result.lastUrl ?? "";
  if (signInFailedUrl(landed) || !new RegExp(destinationPattern).test(landed)) {
    throw new Error(`sign-in did not reach ${destinationPath}; landed on ${landed || "(unknown)"}`);
  }
  process.stdout.write(`signed-in destination=${destination}\n`);
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
    else if (command === "_browser-serve") await cmdBrowserServe();
    else usage();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
