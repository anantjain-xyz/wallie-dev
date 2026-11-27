import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent } from "node:http";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fixture, pipelineApi, runtimeCases } from "./runtime-cases.mjs";
import { request, sampleRoute, summarize } from "./runtime-http.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = new URL("http://127.0.0.1:3102");
const volumes = [160, 3200];
const warmups = 2;
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|CI|LANG|LC_ALL|TMPDIR|COREPACK_HOME|PNPM_HOME)$/.test(key),
  ),
);

class BenchError extends Error {}

function localStack() {
  if (readdirSync(root).some((name) => /^\.env(?:\.|$)/.test(name) && name !== ".env.example")) {
    throw new BenchError("Use a disposable checkout without auto-loaded .env files.");
  }
  const container = spawnSync(
    "docker",
    [
      "inspect",
      "--type",
      "container",
      "--format",
      '{{index .Config.Labels "com.supabase.cli.workdir"}}',
      "supabase_db_wallie-dev",
    ],
    {
      cwd: root,
      env: baseEnv,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (container.status !== 0 || container.stdout.trim() !== resolve(root)) {
    throw new BenchError(
      "Start a disposable local Supabase stack from this checkout, not another checkout.",
    );
  }
  const status = spawnSync("supabase", ["status", "-o", "env"], {
    cwd: root,
    env: { ...baseEnv, SUPABASE_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.status !== 0) throw new BenchError("Start the stock local Supabase stack first.");
  const configs = Object.fromEntries(
    [...status.stdout.matchAll(/^([A-Z_]+)="([^"\r\n]*)"\r?$/gm)].map((match) => match.slice(1)),
  );
  const normalLoopback = (value, protocol, port) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new BenchError("Local Supabase returned an invalid endpoint.");
    }
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.protocol !== protocol ||
      url.port !== port ||
      url.search ||
      url.hash
    )
      throw new BenchError("Expected the stock loopback Supabase ports and protocol.");
    url.hostname = "127.0.0.1";
    return url;
  };
  const api = normalLoopback(configs.API_URL, "http:", "54321");
  const db = normalLoopback(configs.DB_URL, "postgresql:", "54322");
  if (
    api.pathname !== "/" ||
    api.username ||
    api.password ||
    db.pathname !== "/postgres" ||
    db.username !== "postgres" ||
    !db.password ||
    !configs.PUBLISHABLE_KEY ||
    !configs.SECRET_KEY
  )
    throw new BenchError("Expected local Supabase keys and the stock connection settings.");
  return { api, db, publishable: configs.PUBLISHABLE_KEY, secret: configs.SECRET_KEY };
}

function sql(stack, input, args = []) {
  const result = spawnSync("psql", ["-XqAt", "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: root,
    env: {
      ...baseEnv,
      PGHOST: stack.db.hostname,
      PGPORT: stack.db.port,
      PGUSER: stack.db.username,
      PGDATABASE: "postgres",
      PGPASSWORD: decodeURIComponent(stack.db.password),
      PGCONNECT_TIMEOUT: "5",
    },
    input,
    encoding: "utf8",
    timeout: 100_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new BenchError("Fixture SQL failed. Use psql and a fresh, disposable demo database.");
  }
  return result.stdout.trim();
}

function seed(stack, volume) {
  sql(stack, readFileSync(new URL("./seed-authenticated-runtime.sql", import.meta.url), "utf8"), [
    "-v",
    `fixture_size=${volume}`,
  ]);
}

function build(env) {
  const build = spawnSync("pnpm", ["build"], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [stream, text] of [
    [process.stdout, build.stdout],
    [process.stderr, build.stderr],
  ]) {
    if (text)
      stream.write(
        text
          .replaceAll(env.SUPABASE_SECRET_KEY, "[local key]")
          .replaceAll(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "[local key]")
          .replaceAll(env.WALLIE_ENCRYPTION_KEY, "[local key]"),
      );
  }
  if (build.status !== 0) throw new BenchError("The standard production build failed.");
  return readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim();
}

async function start(env) {
  const child = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      app.hostname,
      "--port",
      app.port,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "ignore"] },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const ready = new Promise((resolve, reject) => {
    let output = "";
    const check = (chunk) => {
      output = (output + chunk).slice(-4096);
      if (output.includes("Ready in")) resolve();
    };
    const timer = setTimeout(
      () => reject(new BenchError("Production server did not start.")),
      20_000,
    );
    child.stdout.on("data", check);
    child.on("error", () => reject(new BenchError("Could not launch the production server.")));
    child.once("close", () => reject(new BenchError("Production server exited before serving.")));
    void closed.then(() => clearTimeout(timer));
  });
  const stop = async () => {
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await closed;
    clearTimeout(timer);
  };
  try {
    await ready;
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

async function signIn(stack, agent, email, create = false) {
  const json = "application/json";
  const adminPost = (path, data) =>
    request(new URL(path, stack.api), {
      agent,
      method: "POST",
      headers: {
        apikey: stack.secret,
        authorization: `Bearer ${stack.secret}`,
        "content-type": json,
      },
      body: JSON.stringify(data),
      maxBytes: 32_000,
    });
  if (create) {
    const user = await adminPost("/auth/v1/admin/users", { email, email_confirm: true });
    if (user.status !== 200 && user.status !== 201)
      throw new BenchError("Could not create a local fixture nonmember.");
  }

  const next = `/w/${fixture.slug}/sessions`;
  const redirectTo = `http://localhost:3000/auth/confirm?${new URLSearchParams({ next })}`;
  const redirect = new URLSearchParams({ redirect_to: redirectTo });
  const link = await adminPost(`/auth/v1/admin/generate_link?${redirect}`, {
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  let token;
  if (link.status === 200 && link.body) {
    try {
      const data = JSON.parse(link.body);
      token = data?.hashed_token ?? data?.properties?.hashed_token;
    } catch {
      throw new BenchError("Local Supabase returned an invalid magic link.");
    }
  }
  if (typeof token !== "string" || !token)
    throw new BenchError("Local Supabase did not supply a magic-link token.");

  const params = new URLSearchParams({ next, type: "email", token_hash: token });
  const confirmation = await request(new URL(`/auth/confirm?${params}`, app), {
    agent,
    maxBytes: 32_000,
  });
  const cookies = (confirmation.headers["set-cookie"] ?? [])
    .map((setCookie) => setCookie.split(";", 1)[0])
    .filter((cookie) => /^sb-[^=]+-auth-token(?:\.\d+)?=./.test(cookie));
  const destination = new URL(confirmation.headers.location ?? "/", app);
  if (destination.hostname === "localhost") destination.hostname = app.hostname;
  if (
    confirmation.status !== 303 ||
    destination.href !== new URL(next, app).href ||
    !cookies.length
  )
    throw new BenchError("Wallie did not issue a session for the local fixture user.");
  return cookies.join("; ");
}

async function checkDenials(agent, outsider) {
  const artifact =
    "/api/sessions/fa1e1000-0000-4000-8000-000000000002/artifacts?stage=plan&latest=true";
  const checks = [];
  for (const [name, path] of [
    ["pipeline", pipelineApi],
    ["long-artifact", artifact],
  ]) {
    for (const [role, cookie, expected] of [
      ["anonymous", "", 401],
      ["nonmember", outsider, 404],
    ]) {
      let status = null;
      let ok = false;
      try {
        const response = await request(new URL(path, app), {
          agent,
          headers: { accept: "application/json", cookie },
          maxBytes: 8_000,
        });
        status = response.status;
        const data = status === expected && JSON.parse(response.body ?? "null");
        ok =
          typeof data?.error === "string" &&
          (name === "pipeline"
            ? data.code === "workspace_unavailable" && !("lanes" in data)
            : !("artifact" in data));
      } catch {
        ok = false;
      }
      checks.push({ name, role, expected, status, ok });
    }
  }
  return checks;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { runs: { type: "string" }, out: { type: "string" } } }));
  } catch {
    throw new BenchError("Usage: pnpm bench:authenticated [--runs 1-15] [--out FILE]");
  }
  const runs = Number(values.runs ?? 5);
  if (!Number.isInteger(runs) || runs < 1 || runs > 15) throw new BenchError("Use --runs 1-15.");
  const out = resolve(root, values.out ?? "bench-results/authenticated-runtime.json");
  const stack = localStack();
  seed(stack, volumes[0]);
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_APP_URL: app.origin,
    NEXT_PUBLIC_SUPABASE_URL: stack.api.origin,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishable,
    SUPABASE_SECRET_KEY: stack.secret,
    WALLIE_DEPLOY_ENV: "preview",
    WALLIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    WALLIE_SANDBOX_IMPL: "fake",
  };
  const buildId = build(env);
  const stop = await start(env);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const results = [];
  try {
    const cookie = await signIn(stack, agent, fixture.email);
    const hostLoadBefore = loadavg();
    for (const volume of volumes) {
      if (volume !== volumes[0]) seed(stack, volume);
      const routes = runtimeCases(volume);
      const samples = Object.fromEntries(routes.map(({ name }) => [name, []]));
      for (let sweep = 0; sweep < warmups + runs; sweep++) {
        for (const route of sweep >= warmups && (sweep - warmups) % 2
          ? routes.toReversed()
          : routes) {
          samples[route.name].push(await sampleRoute(app, route, { agent, cookie }));
        }
      }
      for (const { name, maxBytes } of routes) {
        const timed = samples[name].slice(warmups);
        results.push({
          name,
          fixtureSessions: volume + 18,
          maxBytes,
          warmups: samples[name].slice(0, warmups),
          summary: summarize(timed),
          samples: timed,
        });
      }
    }
    const hostLoadAfter = loadavg();
    const outsider = await signIn(stack, agent, "runtime-nonmember@example.test", true);
    const authorization = await checkDenials(agent, outsider);
    const noJobs = sql(stack, "select not exists (select 1 from public.agent_jobs);") === "t";
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          buildId,
          node: process.version,
          hostLoadBefore,
          hostLoadAfter,
          runs,
          authorization,
          noJobs,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    for (const row of results) {
      const { valid, failed, readyMs, bytes } = row.summary;
      const time = readyMs
        ? `${readyMs.median.toFixed(1)} ms [${readyMs.min.toFixed(1)}–${readyMs.max.toFixed(1)}]`
        : "n/a";
      const errors = [...row.warmups, ...row.samples]
        .filter((s) => s.error)
        .map((s) => `${s.error} (${s.status ?? "no status"})`);
      console.log(
        `${row.fixtureSessions} ${row.name}: ${valid} valid, ${failed} failed; ${time}; ${bytes?.max ?? "n/a"}/${row.maxBytes} B${errors.length ? `; errors: ${errors.join(", ")}` : ""}`,
      );
    }
    const denied = authorization.filter((check) => check.ok).length;
    console.log(
      `Authorization: ${denied}/${authorization.length} expected denials; no queued jobs: ${noJobs}.`,
    );
    if (
      !noJobs ||
      denied !== authorization.length ||
      results.some((row) => row.summary.failed || row.warmups.some((s) => s.error))
    ) {
      process.exitCode = 1;
    }
  } finally {
    agent.destroy();
    await stop();
  }
}

main().catch((error) => {
  console.error(
    error instanceof BenchError
      ? error.message
      : "Authenticated runtime benchmark could not complete.",
  );
  process.exitCode = 1;
});
