/** Run both real worker entry points against a disposable local database. */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { checkFactoryWorkflowHandoff } from "./check-factory-workflow-handoff";

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
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // The loopback listener may take a moment to bind.
    }
    await delay(200);
  }
  throw new FixtureConfigurationError("The production Wallie fixture did not become ready.");
}

function childExitCode(child: ChildProcess) {
  return new Promise<number | null>((finished, failed) => {
    child.once("error", failed);
    child.once("close", finished);
  });
}

async function runFactoryRuntime() {
  let app: ChildProcess | undefined;
  let appClosed: Promise<void> | undefined;
  let builder: ChildProcess | undefined;
  let runtime: ChildProcess | undefined;
  let stopM12: ((signal: NodeJS.Signals) => void) | undefined;
  let interrupted = false;
  try {
    const [flag, directory, ...extra] = process.argv.slice(2);
    const m05 = extra.length === 1 && extra[0] === "--m05";
    const m06 = extra.length === 1 && extra[0] === "--m06";
    const m07 = extra.length === 1 && extra[0] === "--m07";
    const m08 = extra.length === 1 && extra[0] === "--m08";
    const m11 = extra.length === 1 && extra[0] === "--m11";
    const m12 = extra.length === 1 && extra[0] === "--m12";
    if (
      flag !== "--workdir" ||
      !directory ||
      (extra.length > 0 && !m05 && !m06 && !m07 && !m08 && !m11 && !m12)
    ) {
      throw new FixtureConfigurationError(
        "Pass --workdir with a disposable local Supabase project and optionally --m05, --m06, --m07, --m08, --m11, or --m12.",
      );
    }
    if (m12) {
      stopM12 = (signal) => {
        if (interrupted) return;
        interrupted = true;
        process.exitCode = signal === "SIGINT" ? 130 : 143;
        builder?.kill("SIGTERM");
        app?.kill("SIGTERM");
        runtime?.kill("SIGTERM");
      };
      process.on("SIGINT", stopM12);
      process.on("SIGTERM", stopM12);
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

    const fixture = { url, serviceKey, publishableKey };
    const env: NodeJS.ProcessEnv = {
      ...(m07 || m08 || m11 || m12
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
        ...fixture,
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

    if (m08 && !status.JWT_SECRET) {
      throw new FixtureConfigurationError(
        "The disposable database's local JWT secret is unavailable.",
      );
    }
    if (
      m12 &&
      [".env", ".env.local", ".env.production", ".env.production.local"].some((file) =>
        existsSync(resolve(file)),
      )
    ) {
      throw new FixtureConfigurationError(
        "Run M12 qualification in a worktree without local application credentials.",
      );
    }
    if (m05 || m07 || m08 || m12) {
      const port = await loopbackPort();
      if (interrupted) return;
      const host = m08 ? "localhost" : "127.0.0.1";
      const appUrl = `http://${host}:${port}`;
      const next = resolve("node_modules/next/dist/bin/next");
      if (m07 || m08 || m12) env.NEXT_PUBLIC_APP_URL = appUrl;
      if (m12) {
        env.GITHUB_APP_ID = "1";
        env.GITHUB_APP_PRIVATE_KEY = "fixture-no-github-app-private-key";
        env.GITHUB_WEBHOOK_SECRET = randomBytes(32).toString("hex");
      }
      const appEnv: NodeJS.ProcessEnv = {
        ...env,
        NEXT_PUBLIC_APP_URL: appUrl,
        NODE_ENV: "production",
        ...(m12 && {
          NODE_OPTIONS: "--import ./test/release/factory-automation-runtime-fetch.mjs",
        }),
        ...(m08
          ? {
              WALLIE_WORKER_WAKE_URL: "",
              WALLIE_WORKER_WAKE_SECRET: "",
              OPENROUTER_API_KEY: "",
            }
          : {}),
      };
      const buildOptions = {
        env: appEnv,
        stdio: "inherit" as const,
        timeout: 240_000,
      };
      let buildStatus: number | null;
      if (m12) {
        builder = spawn(process.execPath, [next, "build"], buildOptions);
        buildStatus = await childExitCode(builder);
        builder = undefined;
      } else {
        buildStatus = spawnSync(process.execPath, [next, "build"], buildOptions).status;
      }
      if (interrupted) return;
      if (buildStatus !== 0) {
        throw new FixtureConfigurationError("The production Wallie fixture build failed.");
      }
      const localApp = spawn(
        process.execPath,
        [next, "start", "--hostname", host, "--port", String(port)],
        {
          env: appEnv,
          stdio: "inherit",
        },
      );
      app = localApp;
      if (m12) {
        appClosed = new Promise<void>((finished) => localApp.once("close", () => finished()));
      }
      localApp.on("error", () => localApp.kill());
      await waitForWallie(localApp, appUrl);
      if (interrupted) return;
      if (m07) {
        env.WALLIE_FACTORY_SCORER_BROWSER_URL = appUrl;
        env.WALLIE_FACTORY_SCORER_PROOF_DIR = resolve(
          process.env.WALLIE_FACTORY_SCORER_PROOF_DIR ?? ".wallie/m07-qualification",
        );
      } else if (m05) {
        env.WALLIE_FACTORY_MEDIA_BROWSER_URL = appUrl;
        env.WALLIE_FACTORY_MEDIA_PROOF_DIR = resolve(
          process.env.WALLIE_FACTORY_MEDIA_PROOF_DIR ?? ".wallie/m05-qualification",
        );
      }
    }

    if (m12) {
      runtime = spawn(
        process.execPath,
        [
          "--import",
          "./scripts/register-server-only.mjs",
          "--import",
          "tsx",
          "test/release/factory-automation-runtime.ts",
        ],
        {
          env: { ...env, WALLIE_M12_DATABASE_URL: databaseUrl },
          stdio: "inherit",
          timeout: 720_000,
        },
      );
      const runtimeStatus = await childExitCode(runtime);
      if (!interrupted) process.exitCode = runtimeStatus ?? 1;
      return;
    }

    if (m08) {
      const outputRoot = resolve(".wallie/m08-qualification");
      mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
      const proof = mkdtempSync(join(outputRoot, "run-"));
      const witnessPath = join(proof, "witness.json");
      const nodeTest = "test/release/factory-benchmark-qualification.node.fixture.ts";
      const nativeTest = "cloudflare/tests/factory-benchmark-qualification.fixture.test.ts";
      const fixtureEnv = {
        ...env,
        WALLIE_M08_DATABASE_URL: databaseUrl,
        WALLIE_M08_LOCAL_JWT_SECRET: status.JWT_SECRET,
        WALLIE_M08_FIXTURE_PASSWORD: randomBytes(32).toString("hex"),
        WALLIE_M08_WITNESS_PATH: witnessPath,
      };
      for (const phase of ["prepare", "native", "abandon", "recover", "browser"]) {
        const native = phase === "native";
        const result = spawnSync(
          process.execPath,
          [
            resolve("node_modules/vitest/vitest.mjs"),
            "run",
            native ? nativeTest : nodeTest,
            "--config",
            native ? "cloudflare/vitest.config.mts" : "vitest.factory-runtime.config.ts",
            "--testTimeout=180000",
          ],
          {
            env: {
              ...fixtureEnv,
              // The native runtime only receives the loopback client configuration and public witness.
              ...(native
                ? {
                    WALLIE_M08_LOCAL_JWT_SECRET: undefined,
                    WALLIE_M08_FIXTURE_PASSWORD: undefined,
                  }
                : {}),
              WALLIE_M08_PHASE: phase,
              WALLIE_FACTORY_RUNTIME_FIXTURE: JSON.stringify({
                ...fixture,
                ...(native ? { m08Witness: readFileSync(witnessPath, "utf8") } : {}),
              }),
            },
            stdio: "inherit",
            timeout: 240_000,
          },
        );
        if (result.status !== 0) {
          throw new FixtureConfigurationError(
            `M08 ${phase} failed. Local evidence is in ${proof}.`,
          );
        }
      }
      for (const directory of ["export", "browser"]) {
        const parts = join(proof, directory);
        const manifest = readdirSync(parts).find((name) => name.endsWith("-manifest.json"));
        if (!manifest) throw new FixtureConfigurationError(`M08 ${directory} manifest is absent.`);
        const verifier = spawnSync(
          "python3",
          [
            "scripts/verify-benchmark-qualification-export.py",
            join(parts, manifest),
            "--expected-trials",
            "8",
            "--original-snapshot",
            join(proof, "original-comparison.json"),
          ],
          { env: { NODE_ENV: "test", PATH: env.PATH }, stdio: "inherit", timeout: 30_000 },
        );
        if (verifier.status !== 0) {
          throw new FixtureConfigurationError(
            `M08 ${directory} export verification failed. Local evidence is in ${proof}.`,
          );
        }
      }
      console.log(`M08 local qualification evidence is in ${proof}.`);
      return;
    }

    if (m11) {
      try {
        checkFactoryWorkflowHandoff(databaseUrl, fixture, env);
      } catch (error) {
        throw new FixtureConfigurationError(
          error instanceof Error ? error.message : "The M11 workflow handoff failed.",
        );
      }
      return;
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
    if (interrupted) return;
    // Supabase status errors may include local connection credentials.
    console.error(
      error instanceof FixtureConfigurationError
        ? error.message
        : "Could not start the factory runtime fixture. Start the disposable local project first.",
    );
    process.exitCode = 1;
  } finally {
    app?.kill();
    if (app && appClosed) {
      const stopped = await Promise.race([
        appClosed.then(() => true),
        delay(10_000, false, { ref: false }),
      ]);
      if (!stopped) {
        app.kill("SIGKILL");
        await appClosed;
      }
    }
    if (stopM12) {
      process.off("SIGINT", stopM12);
      process.off("SIGTERM", stopM12);
    }
  }
}

void runFactoryRuntime();
