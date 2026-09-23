import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parse, stringify } from "yaml";

import { assertTapPassed } from "./fixtures/qualification-tap.mjs";
import { checkSelfHostedSupabase } from "./fixtures/self-hosted-supabase-probe.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(
  await readFile(new URL("../infra/supabase/upstream.lock.json", import.meta.url)),
);
const project = `wallie-qualification-${randomBytes(6).toString("hex")}`;
const artifacts = join(root, ".wallie", "self-hosted-supabase");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const logPath = join(artifacts, `${project}.log`);
const reportPath = join(artifacts, `${project}.json`);
const directory = await mkdtemp(join(tmpdir(), `${project}-`));
const checkout = join(directory, "upstream");
const stack = join(directory, "stack");
let activeChild;
let interrupted = false;
const cancellation = new AbortController();
let composeArgs;
let composeEnv;
let started = false;
let result;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    cancellation.abort(new Error("Qualification interrupted"));
    activeChild?.kill("SIGTERM");
  });
}

async function run(
  command,
  args,
  { cwd = root, env = process.env, input, cleanup = false, sensitive = false } = {},
) {
  if (interrupted && !cleanup) throw new Error("Qualification interrupted");
  const output = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let tooLarge = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) {
        tooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) {
        tooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      activeChild = undefined;
      reject(new Error(`${command} could not start (${error.code})`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      resolve({ stdout, stderr, code, signal, tooLarge });
    });
    child.stdin.end(input);
  });
  // Service logs can contain ephemeral tokens; keep diagnostics local and private.
  if (!sensitive) await appendFile(logPath, output.stdout + output.stderr, { mode: 0o600 });
  if (output.code !== 0 || output.tooLarge) {
    if (sensitive) {
      throw new Error(
        `${command} failed (${output.signal ?? output.code}); sensitive output withheld`,
      );
    }
    throw new Error(
      `${command} failed (${output.signal ?? output.code}); see private log ${logPath}`,
    );
  }
  return output.stdout;
}

const compose = (args, options = {}) =>
  run("docker", [...composeArgs, ...args], { cwd: stack, env: composeEnv, ...options });

function jwt(role, secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    role,
    iss: "supabase",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7200,
  })}`;
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64url")}`;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  if (process.argv.length !== 2)
    throw new Error("Usage: node scripts/check-self-hosted-supabase.mjs");
  const contextEndpoint = async (name) =>
    (
      await run("docker", [
        "context",
        "inspect",
        ...(name ? [name] : []),
        "--format",
        "{{.Endpoints.docker.Host}}",
      ])
    ).trim();
  // Docker's context override takes precedence over DOCKER_HOST.
  const dockerEndpoint = process.env.DOCKER_CONTEXT
    ? await contextEndpoint(process.env.DOCKER_CONTEXT)
    : process.env.DOCKER_HOST || (await contextEndpoint());
  if (!dockerEndpoint.startsWith("unix://")) {
    throw new Error("Qualification requires a local Docker daemon using a Unix socket");
  }
  console.log(`[self-hosted] Fetching ${lock.release} (${lock.commit.slice(0, 8)})`);
  await run("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--depth=1",
    "--branch",
    lock.release,
    lock.repository,
    checkout,
  ]);
  const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).trim();
  if (commit !== lock.commit)
    throw new Error("Upstream release no longer matches the locked commit");
  await run("git", ["sparse-checkout", "set", "docker"], { cwd: checkout });
  await run("git", ["checkout", "--detach", lock.commit], { cwd: checkout });
  await cp(join(checkout, "docker"), stack, { recursive: true });

  const env = parseEnv(await readFile(join(stack, ".env.example"), "utf8"));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  Object.assign(env, {
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    JWT_SECRET: randomBytes(32).toString("hex"),
    SECRET_KEY_BASE: randomBytes(48).toString("hex"),
    REALTIME_DB_ENC_KEY: randomBytes(8).toString("hex"),
    VAULT_ENC_KEY: randomBytes(16).toString("hex"),
    PG_META_CRYPTO_KEY: randomBytes(32).toString("hex"),
    DASHBOARD_PASSWORD: randomBytes(32).toString("hex"),
    S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString("hex"),
    SUPABASE_PUBLIC_URL: url,
    API_EXTERNAL_URL: `${url}/auth/v1`,
    SITE_URL: url,
    POSTGRES_HOST: "db",
    POSTGRES_PORT: "5432",
    POSTGRES_DB: "postgres",
    PGRST_DB_SCHEMAS: "public",
    PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
    ENABLE_EMAIL_AUTOCONFIRM: "true",
    DISABLE_SIGNUP: "true",
    ENABLE_PHONE_SIGNUP: "false",
  });
  env.ANON_KEY = jwt("anon", env.JWT_SECRET);
  env.SERVICE_ROLE_KEY = jwt("service_role", env.JWT_SECRET);
  // Use the locked upstream generator and compose changes rather than inventing
  // a second key format. Its output and temporary files stay private here.
  await writeFile(join(stack, ".env"), `JWT_SECRET=${env.JWT_SECRET}\n`, { mode: 0o600 });
  await run("sh", ["utils/add-new-auth-keys.sh", "--update-env"], {
    cwd: stack,
    sensitive: true,
  });
  const generated = parseEnv(await readFile(join(stack, ".env"), "utf8"));
  for (const [name, prefix] of [
    ["SUPABASE_PUBLISHABLE_KEY", "sb_publishable_"],
    ["SUPABASE_SECRET_KEY", "sb_secret_"],
  ]) {
    if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$`).test(generated[name] ?? "")) {
      throw new Error(`Upstream did not generate a valid ${name}`);
    }
  }
  if (!generated.JWT_KEYS || !generated.JWT_JWKS) {
    throw new Error("Upstream did not generate asymmetric signing keys");
  }
  Object.assign(env, generated);
  await writeFile(
    join(stack, ".env"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const upstream = parse(await readFile(join(stack, "docker-compose.yml"), "utf8"));
  const services = {};
  for (const [name, image] of Object.entries(lock.images)) {
    const service = upstream.services[name];
    if (service?.image !== image) throw new Error(`Upstream image changed for ${name}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(lock.digests[name] ?? "")) {
      throw new Error(`Missing image digest for ${name}`);
    }
    service.image = `${image}@${lock.digests[name]}`;
    delete service.container_name;
    delete service.ports;
    service.restart = "no";
    if (service.depends_on) {
      service.depends_on = Object.fromEntries(
        Object.entries(service.depends_on).filter(([dependency]) => dependency in lock.images),
      );
    }
    services[name] = service;
  }
  services.realtime.networks = { default: { aliases: ["realtime-dev.supabase-realtime"] } };
  services["api-gw"].ports = [`127.0.0.1:${port}:8000`];
  // Named volumes avoid host filesystem permissions and are removed with this project.
  services.db.volumes = services.db.volumes.map((volume) =>
    volume.replace("./volumes/db/data:", "db-data:"),
  );
  for (const name of ["storage", "imgproxy"]) {
    services[name].volumes = services[name].volumes.map((volume) =>
      volume.replace("./volumes/storage:", "storage-data:"),
    );
  }
  await writeFile(
    join(stack, "qualification.yml"),
    stringify({
      services,
      volumes: { "db-data": {}, "db-config": {}, "storage-data": {} },
    }),
    { mode: 0o600 },
  );

  composeEnv = { ...process.env, ...env };
  delete composeEnv.DOCKER_CONTEXT;
  delete composeEnv.DOCKER_HOST;
  composeArgs = [
    "--host",
    dockerEndpoint,
    "compose",
    "--project-name",
    project,
    "--env-file",
    join(stack, ".env"),
    "-f",
    join(stack, "qualification.yml"),
  ];
  await compose(["config", "--quiet"]);
  console.log("[self-hosted] Pulling and starting seven core services on loopback");
  await compose(["pull", "--quiet"]);
  started = true;
  await compose(["up", "--detach", "--wait", "--wait-timeout", "180"]);

  const sql = (input, user = "postgres") =>
    compose(
      [
        "exec",
        "-T",
        "db",
        "psql",
        "-X",
        "-A",
        "-t",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        "postgres",
      ],
      { input },
    );
  const migrationNames = (await readdir(join(root, "supabase", "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (!migrationNames.length) throw new Error("No Wallie migrations found");
  console.log(`[self-hosted] Applying ${migrationNames.length} Wallie migrations and seed`);
  for (const name of migrationNames)
    await sql(await readFile(join(root, "supabase", "migrations", name), "utf8"));
  await sql(await readFile(join(root, "supabase", "seed.sql"), "utf8"));
  await sql("notify pgrst, 'reload schema';");

  const testNames = (await readdir(join(root, "supabase", "tests")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (!testNames.length) throw new Error("No database tests found");
  let assertions = 0;
  console.log(`[self-hosted] Running ${testNames.length} database test files`);
  for (const name of testNames) {
    const connection = `host=db port=5432 dbname=postgres user=supabase_admin password=${env.POSTGRES_PASSWORD}`;
    const output = await sql(
      `set wallie.test_db_connection = '${connection}';\n${await readFile(join(root, "supabase", "tests", name), "utf8")}`,
      "supabase_admin",
    );
    assertions += assertTapPassed(output, name);
  }
  if (assertions < 1) throw new Error("No database assertions executed");
  console.log("[self-hosted] Probing real Auth, REST/RLS, RPC, Realtime, and Storage");
  const checks = await checkSelfHostedSupabase({
    url,
    anonKey: env.SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: env.SUPABASE_SECRET_KEY,
    signal: cancellation.signal,
  });
  const images = parse(await compose(["images", "--format", "json"]));
  result = {
    upstream: lock,
    images,
    migrations: migrationNames.length,
    databaseTestFiles: testNames.length,
    databaseAssertions: assertions,
    checks,
  };
} catch (error) {
  process.exitCode = 1;
  console.error(`[self-hosted] ${error.message}`);
} finally {
  let cleaned = !started;
  if (started) {
    try {
      await compose(["logs", "--no-color", "--tail", "100"], { cleanup: true });
    } catch {
      /* Continue removing the owned project even if diagnostics fail. */
    }
    try {
      await compose(["down", "--volumes", "--remove-orphans", "--timeout", "15"], {
        cleanup: true,
      });
      cleaned = true;
    } catch {
      process.exitCode = 1;
      console.error(
        `[self-hosted] Cleanup failed; project ${project}, configuration ${join(stack, "qualification.yml")}, private log ${logPath}`,
      );
    }
  }
  if (cleaned) await rm(directory, { recursive: true, force: true });
  if (interrupted) process.exitCode = 1;
  if (!process.exitCode && result && cleaned) {
    await writeFile(
      reportPath,
      JSON.stringify({ ...result, completedAt: new Date().toISOString(), cleaned: true }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    console.log(
      `[self-hosted] PASS: ${result.databaseAssertions} database assertions; all service probes passed. Report: ${reportPath}`,
    );
  }
}
