import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { factoryImprovementPublicationSchema } from "../../src/lib/factory-proposals/publication-contracts";

export const improvementBrowserFixtureSchema = z.object({
  workspaceId: z.string().uuid(),
  workspaceSlug: z.string(),
  factoryId: z.string().uuid(),
  ownerEmail: z.string().email(),
  managerEmail: z.string().email(),
  previousRevisionId: z.string().uuid(),
  publication: factoryImprovementPublicationSchema,
});

export async function runImprovementBrowserFixture(
  file: "factory-improvement-adoption-seed.psql" | "factory-improvement-outcomes-seed.psql",
  action: string,
  runId: string,
  values: Record<string, string> = {},
) {
  const host = process.env.WALLIE_ADOPTION_E2E_PG_HOST;
  const database = process.env.WALLIE_ADOPTION_E2E_PG_DATABASE;
  const port = process.env.WALLIE_ADOPTION_E2E_PG_PORT;
  if (
    !host ||
    !(
      /^\/(?:private\/)?tmp\/wallie-[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_-]+)*$/.test(host) ||
      host === "127.0.0.1" ||
      host === "::1"
    ) ||
    !database ||
    !/^(?:postgres|wallie_[a-z0-9_]+)$/.test(database) ||
    (port !== undefined && !/^\d{1,5}$/.test(port))
  ) {
    throw new Error("Use an isolated local Postgres database for the improvement browser fixture.");
  }
  const exec = promisify(execFile);
  const { stdout } = await exec(
    "psql",
    [
      "-XqAt",
      "--host",
      host,
      "--dbname",
      database,
      ...(port ? ["--port", port] : []),
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `run_id=${runId}`,
      "-v",
      `${action}=1`,
      ...Object.entries(values).flatMap(([key, value]) => ["-v", `${key}=${value}`]),
      "-f",
      resolve(__dirname, file),
    ],
    { timeout: 90_000 },
  );
  return JSON.parse(stdout.trim()) as unknown;
}
