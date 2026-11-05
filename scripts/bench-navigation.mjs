import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flows = [
  "pipeline-load",
  "sessions-switch",
  "session-open",
  "settings-switch",
  "new-session-modal",
];

// Local benchmark only. It does not decrypt production data.
const encryptionKey = "0123456789abcdef".repeat(4);

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseStatusEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summarize(samples) {
  return flows.map((flow) => {
    const rows = samples.filter((sample) => sample.flow === flow);
    const okRows = rows.filter((sample) => sample.ok);
    const durations = okRows.map((sample) => sample.durationMs);
    const medianMs = durations.length > 0 ? median(durations) : null;
    const medianRow =
      medianMs === null ? null : okRows.find((sample) => sample.durationMs === medianMs);
    const serverDurations = medianRow
      ? medianRow.serverTimings.map((timing) => timing.durationMs)
      : [];
    return {
      failed: rows.length - okRows.length,
      flow,
      maxMs: durations.length > 0 ? Math.max(...durations) : null,
      medianDocumentBytes: medianRow?.documentBytes ?? null,
      medianMs,
      medianRequestCount: medianRow?.requestCount ?? null,
      medianRscBytes: medianRow?.rscBytes ?? null,
      medianScriptBytes: medianRow?.scriptBytes ?? null,
      medianServerMs: serverDurations.length > 0 ? Math.max(...serverDurations) : null,
      medianServerTimings: medianRow?.serverTimings ?? [],
      medianStyleBytes: medianRow?.styleBytes ?? null,
      medianTtfbMs: medianRow?.ttfbMs ?? null,
      minMs: durations.length > 0 ? Math.min(...durations) : null,
      runs: rows.length,
    };
  });
}

function printSummary(summary) {
  console.log("flow                  median_ms  min_ms  max_ms  ok");
  for (const row of summary) {
    const ok = `${row.runs - row.failed}/${row.runs}`;
    console.log(
      [
        row.flow.padEnd(22),
        String(row.medianMs ?? "fail").padStart(9),
        String(row.minMs ?? "-").padStart(7),
        String(row.maxMs ?? "-").padStart(7),
        ok.padStart(6),
      ].join(" "),
    );
  }
}

const runs = Number(readFlag("--runs", "5"));
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs must be a positive integer.");
}

const statusText = execSync("supabase status -o env", {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const supabase = parseStatusEnv(statusText);
for (const key of ["API_URL", "DB_URL", "PUBLISHABLE_KEY", "SECRET_KEY", "SERVICE_ROLE_KEY"]) {
  if (!supabase[key]) throw new Error(`supabase status did not print ${key}.`);
}

if (!hasFlag("--skip-seed")) {
  execSync(
    `psql "${supabase.DB_URL}" -v ON_ERROR_STOP=1 -f scripts/bench/seed-navigation-volume.sql`,
    {
      cwd: root,
      stdio: "inherit",
    },
  );
}

const benchEnv = {
  ...process.env,
  NEXT_PUBLIC_APP_URL: "http://localhost:3100",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.PUBLISHABLE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: supabase.API_URL,
  PLAYWRIGHT_PORT: "3100",
  SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
  SNAPPY_RUNS: String(runs),
  SUPABASE_SECRET_KEY: supabase.SECRET_KEY,
  WALLIE_DEPLOY_ENV: "preview",
  WALLIE_ENCRYPTION_KEY: encryptionKey,
  WALLIE_TIMING_LOG_PATH: "/tmp/wallie-navigation-bench.jsonl",
  WALLIE_TIMING_LOGS: "1",
};

if (!hasFlag("--skip-build")) {
  execSync("pnpm build", { cwd: root, env: benchEnv, stdio: "inherit" });
}

execSync("pnpm exec playwright install chromium", { cwd: root, env: benchEnv, stdio: "inherit" });

let playwrightOutput = "";
let playwrightStatus = 0;
try {
  playwrightOutput = execSync(
    "pnpm exec playwright test --config playwright.navigation-bench.config.ts",
    {
      cwd: root,
      encoding: "utf8",
      env: benchEnv,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (error) {
  playwrightStatus = typeof error.status === "number" ? error.status : 1;
  playwrightOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  process.stderr.write(playwrightOutput);
}

const benchLine = playwrightOutput.split("\n").find((line) => line.includes("navigation-bench {"));
if (!benchLine) {
  throw new Error("Playwright finished without a navigation-bench JSON line.");
}

const payload = JSON.parse(benchLine.slice(benchLine.indexOf("{")));
const summary = summarize(payload.samples);
printSummary(summary);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = resolve(root, readFlag("--out", `bench-results/navigation-${stamp}.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      cores: cpus().length,
      loadavg: loadavg(),
      payload,
      summary,
    },
    null,
    2,
  ),
);
console.log(`wrote ${outPath}`);

if (playwrightStatus !== 0 || summary.some((row) => row.failed > 0 || row.medianMs === null)) {
  process.exit(1);
}
