import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/database.types";

const exec = promisify(execFile);

/** Test-only admission: never enable a remote or production database. */
async function main() {
  const args = process.argv.slice(2);
  const workdirIndex = args.indexOf("--workdir");
  const workdir = workdirIndex < 0 ? process.cwd() : resolve(args[workdirIndex + 1] ?? "");
  if (workdirIndex >= 0 && !args[workdirIndex + 1]) throw new Error("Missing local workdir.");
  const files =
    workdirIndex < 0 ? args : args.filter((_, i) => i !== workdirIndex && i !== workdirIndex + 1);
  const status = JSON.parse(
    execFileSync("supabase", ["status", "--output", "json", "--workdir", workdir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      timeout: 30_000,
    }),
  ) as Record<string, string>;
  const api = new URL(status.API_URL);
  const db = new URL(status.DB_URL);
  for (const url of [api, db]) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Database tests require an isolated loopback Supabase project.");
  }
  const key = status.SERVICE_ROLE_KEY || status.SECRET_KEY;
  if (!key) throw new Error("The isolated project's service key is unavailable.");
  const admin = createClient<Database>(api.toString(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: states, error } = await admin.rpc("get_git_continuity_release_state");
  if (error || !states?.[0]) throw new Error("Continuity release state is unavailable.");
  const initial = states[0];
  if (!initial.enabled) {
    const { data, error: enableError } = await admin.rpc("set_git_continuity_release", {
      p_enabled: true,
      p_expected_revision: initial.revision,
      p_reason: "Isolated loopback database regression suite",
    });
    if (enableError || !data?.[0]) throw new Error("Local test admission could not be enabled.");
  }
  let exitCode = 0;
  try {
    const child = exec("supabase", ["test", "db", "--local", "--workdir", workdir, ...files], {
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    });
    child.child.stdout?.pipe(process.stdout);
    child.child.stderr?.pipe(process.stderr);
    await child;
  } catch (error) {
    exitCode =
      typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
  } finally {
    if (!initial.enabled) {
      // Gate regression tests deliberately advance the revision. This isolated
      // project requires exclusive test use; still CAS the final restoration.
      const { data: current } = await admin.rpc("get_git_continuity_release_state");
      const { data: restored, error: restoreError } = await admin.rpc(
        "set_git_continuity_release",
        {
          p_enabled: false,
          p_expected_revision: current?.[0]?.revision ?? -1,
          p_reason: "Restore paused state after isolated database regression suite",
        },
      );
      if (restoreError || !restored?.[0]) {
        console.error(
          "Local release control changed during tests; inspect it before further work.",
        );
        exitCode = 1;
      }
    }
  }
  process.exitCode = exitCode;
}

void main().catch(() => {
  console.error(
    "Could not run isolated database tests. Start local Supabase with current migrations.",
  );
  process.exitCode = 1;
});
