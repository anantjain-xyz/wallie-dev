/** Local-only integrated release proof. Never reads production environment files. */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

class LocalFixtureConfigurationError extends Error {}

function localUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new LocalFixtureConfigurationError(
      `Continuity ${label} must point to a loopback service.`,
    );
  return value;
}

try {
  let status: Record<string, string> = {};
  if (!process.env.WALLIE_CONTINUITY_SERVICE_ROLE_KEY) {
    const output = execFileSync(
      "supabase",
      [
        "status",
        "--output",
        "json",
        ...(process.env.WALLIE_CONTINUITY_SUPABASE_WORKDIR
          ? ["--workdir", process.env.WALLIE_CONTINUITY_SUPABASE_WORKDIR]
          : []),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      },
    );
    status = JSON.parse(output) as Record<string, string>;
  }
  const apiUrl = localUrl(
    process.env.WALLIE_CONTINUITY_SUPABASE_URL ?? status.API_URL ?? "http://127.0.0.1:50321",
    "API",
  );
  const dbUrl = localUrl(
    process.env.WALLIE_CONTINUITY_DB_URL ??
      status.DB_URL ??
      "postgresql://postgres:postgres@127.0.0.1:50322/postgres",
    "database",
  );
  const key =
    process.env.WALLIE_CONTINUITY_SERVICE_ROLE_KEY ?? status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!key)
    throw new LocalFixtureConfigurationError("Local Supabase service credentials are unavailable.");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALLIE_CONTINUITY_SUPABASE_URL: apiUrl,
    WALLIE_CONTINUITY_DB_URL: dbUrl,
    WALLIE_CONTINUITY_SERVICE_ROLE_KEY: key,
    WALLIE_SANDBOX_IMPL: "fake",
  };
  delete env.WALLIE_WORKER_WAKE_URL;
  delete env.WALLIE_WORKER_WAKE_SECRET;
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "test/release/continuity.fixture.ts",
      "--config",
      "vitest.continuity.config.ts",
    ],
    { env, stdio: "inherit", timeout: 240_000 },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  // CLI failures can carry connection strings or keys in their captured output.
  console.error(
    error instanceof LocalFixtureConfigurationError
      ? error.message
      : "Continuity release fixture could not start. Start the isolated local Supabase stack and apply migrations first.",
  );
  process.exitCode = 1;
}
