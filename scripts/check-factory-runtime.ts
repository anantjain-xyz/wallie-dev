/** Run both real worker entry points against a disposable local database. */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

async function loopbackPort() {
  const reservation = createServer();
  return new Promise<number>((resolvePort, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      reservation.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("Missing local port."));
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForWallie(app: ChildProcess, url: string) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline && app.exitCode === null && app.signalCode === null) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // The loopback listener may take a moment to bind.
    }
    await delay(200);
  }
  throw new FixtureConfigurationError("The production Wallie fixture did not become ready.");
}

async function runFactoryRuntime() {
  let app: ChildProcess | undefined;
  try {
    const [flag, directory, ...extra] = process.argv.slice(2);
    const m05 = extra.length === 1 && extra[0] === "--m05";
    const m06 = extra.length === 1 && extra[0] === "--m06";
    const m07 = extra.length === 1 && extra[0] === "--m07";
    if (flag !== "--workdir" || !directory || (extra.length > 0 && !m05 && !m06 && !m07)) {
      throw new FixtureConfigurationError(
        "Pass --workdir with a disposable local Supabase project and optionally --m05, --m06, or --m07.",
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
    const databaseUrl = loopbackUrl(status.DB_URL, ["postgresql:", "postgres:"]);
    const serviceKey = status.SERVICE_ROLE_KEY || status.SECRET_KEY;
    const publishableKey = status.ANON_KEY || status.PUBLISHABLE_KEY;
    if (!serviceKey || !publishableKey) {
      throw new FixtureConfigurationError("The local test credentials are unavailable.");
    }

    if (m06) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "test/release/factory-outcome-runtime.ts"],
        {
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            NEXT_PUBLIC_APP_URL: url,
            NEXT_PUBLIC_SUPABASE_URL: url,
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
            SUPABASE_SECRET_KEY: serviceKey,
            WALLIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
            WALLIE_FACTORY_ANALYTICS_DATABASE_URL: databaseUrl,
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
            WRANGLER_SEND_METRICS: "false",
          },
          stdio: "inherit",
        },
      );
      process.exitCode = result.status ?? 1;
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...(m07
        ? {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
            NEXT_TELEMETRY_DISABLED: "1",
          }
        : process.env),
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SECRET_KEY: serviceKey,
      WALLIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      WALLIE_FACTORY_RUNTIME_FIXTURE: JSON.stringify({
        url,
        serviceKey,
        publishableKey,
        ...(m05 ? { m05: true } : {}),
        ...(m07 ? { m07: true } : {}),
      }),
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      WRANGLER_SEND_METRICS: "false",
    };
    delete env.WALLIE_SANDBOX_IMPL;
    delete env.WALLIE_WORKER_WAKE_URL;
    delete env.WALLIE_WORKER_WAKE_SECRET;
    delete env.WALLIE_NATIVE_HISTORY_FIXTURE;
    delete env.OPENROUTER_API_KEY;

    if (m05 || m07) {
      const port = await loopbackPort();
      const appUrl = `http://127.0.0.1:${port}`;
      const next = resolve("node_modules/next/dist/bin/next");
      if (m07) env.NEXT_PUBLIC_APP_URL = appUrl;
      const appEnv: NodeJS.ProcessEnv = {
        ...env,
        NEXT_PUBLIC_APP_URL: appUrl,
        NODE_ENV: "production",
      };
      const build = spawnSync(process.execPath, [next, "build"], {
        env: appEnv,
        stdio: "inherit",
        timeout: 240_000,
      });
      if (build.status !== 0) {
        throw new FixtureConfigurationError("The production Wallie fixture build failed.");
      }
      const localApp = spawn(
        process.execPath,
        [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
        {
          env: appEnv,
          stdio: "inherit",
        },
      );
      app = localApp;
      localApp.on("error", () => localApp.kill());
      await waitForWallie(localApp, appUrl);
      if (m07) {
        env.WALLIE_FACTORY_SCORER_BROWSER_URL = appUrl;
        env.WALLIE_FACTORY_SCORER_PROOF_DIR = resolve(
          process.env.WALLIE_FACTORY_SCORER_PROOF_DIR ?? ".wallie/m07-qualification",
        );
      } else {
        env.WALLIE_FACTORY_MEDIA_BROWSER_URL = appUrl;
        env.WALLIE_FACTORY_MEDIA_PROOF_DIR = resolve(
          process.env.WALLIE_FACTORY_MEDIA_PROOF_DIR ?? ".wallie/m05-qualification",
        );
      }
    }

    const entries = [
      ["test/release/factory-runtime.node.fixture.ts", "vitest.factory-runtime.config.ts"],
      ["cloudflare/tests/factory-runtime.fixture.test.ts", "cloudflare/vitest.config.mts"],
    ];
    for (const [file, config] of entries) {
      const result = spawnSync(
        process.execPath,
        [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          file,
          "--config",
          config,
          ...(m05 || m07 ? ["--testTimeout=180000"] : []),
        ],
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
  } finally {
    app?.kill();
  }
}

void runFactoryRuntime();
