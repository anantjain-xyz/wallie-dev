/** Run both real worker entry points against a disposable local database. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

class FixtureConfigurationError extends Error {}

function loopbackUrl(value: string | undefined, protocols: readonly string[]) {
  const url = new URL(value ?? "");
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new FixtureConfigurationError(
      "Factory runtime tests require loopback Supabase services.",
    );
  }
  return url.toString();
}

try {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== "--workdir" || !directory || extra.length) {
    throw new FixtureConfigurationError(
      "Pass --workdir with the path to a disposable local Supabase project.",
    );
  }
  const status = JSON.parse(
    execFileSync("supabase", ["status", "--workdir", resolve(directory), "--output", "json"], {
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }),
  ) as Record<string, string>;
  const url = loopbackUrl(status.API_URL, ["http:"]);
  loopbackUrl(status.DB_URL, ["postgresql:", "postgres:"]);
  const serviceKey = status.SERVICE_ROLE_KEY || status.SECRET_KEY;
  const publishableKey = status.ANON_KEY || status.PUBLISHABLE_KEY;
  if (!serviceKey || !publishableKey) {
    throw new FixtureConfigurationError("The local test credentials are unavailable.");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: serviceKey,
    WALLIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    WALLIE_FACTORY_RUNTIME_FIXTURE: JSON.stringify({ url, serviceKey, publishableKey }),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  delete env.WALLIE_SANDBOX_IMPL;
  delete env.WALLIE_WORKER_WAKE_URL;
  delete env.WALLIE_WORKER_WAKE_SECRET;
  delete env.WALLIE_NATIVE_HISTORY_FIXTURE;
  delete env.OPENROUTER_API_KEY;

  const entries = [
    ["test/release/factory-runtime.node.fixture.ts", "vitest.factory-runtime.config.ts"],
    ["cloudflare/tests/factory-runtime.fixture.test.ts", "cloudflare/vitest.config.mts"],
  ];
  for (const [file, config] of entries) {
    const result = spawnSync(
      process.execPath,
      [resolve("node_modules/vitest/vitest.mjs"), "run", file, "--config", config],
      { env, stdio: "inherit", timeout: 240_000 },
    );
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} catch (error) {
  // Supabase status errors may include local connection credentials.
  console.error(
    error instanceof FixtureConfigurationError
      ? error.message
      : "Could not start the factory runtime fixture. Start the disposable local project first.",
  );
  process.exitCode = 1;
}
