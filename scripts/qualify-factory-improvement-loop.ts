import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { authenticateQualificationOwner } from "../e2e/helpers/factory-improvement-loop-qualification";
import type { Database } from "../src/lib/supabase/database.types";
import {
  factoryImprovementLoopManifestSchema,
  improvementLoopPreparedSchema,
  improvementQualificationDatabaseEnvironment,
  loopbackQualificationUrl,
  type ImprovementLoopContext,
} from "../test/release/factory-improvement-loop-contract";
import {
  improvementLoopBaseProofSchema,
  publishImprovementLoop,
  readImprovementLoopGitHubInstallation,
} from "../test/release/factory-improvement-loop-publication";
import { prepareImprovementLoopSource } from "../test/release/factory-improvement-loop-source";
import { qualifyImprovementLoopValidation } from "../test/release/factory-improvement-loop-validation";

const statusSchema = z.object({
  API_URL: z.string(),
  DB_URL: z.string(),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
});
const preparingSchema = z.object({ preparing: z.literal(true), runId: z.string().uuid() }).strict();
const savedPreparationSchema = improvementLoopPreparedSchema.extend({
  baseProof: improvementLoopBaseProofSchema.optional(),
  installationId: z.number().int().positive().safe().nullable(),
});
const savedStateSchema = z.union([
  factoryImprovementLoopManifestSchema,
  savedPreparationSchema,
  preparingSchema,
]);
type SavedState = z.output<typeof savedStateSchema>;

function commandArguments() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workdir: { type: "string" },
      "status-file": { type: "string" },
      state: { type: "string" },
      "app-origin": { type: "string" },
      live: { type: "boolean" },
    },
  });
  const [command] = positionals;
  const statusPath = values["status-file"];
  if (
    positionals.length !== 1 ||
    !["prepare", "publish"].includes(command) ||
    Boolean(values.workdir) === Boolean(statusPath) ||
    !values.state
  ) {
    throw new Error(
      "Use prepare or publish with --state and either --workdir or a private local --status-file. Prepare also needs --app-origin.",
    );
  }
  return {
    command,
    workdir: values.workdir ? resolve(values.workdir) : undefined,
    statusPath: statusPath ? resolve(statusPath) : undefined,
    statePath: resolve(values.state),
    appOrigin: values["app-origin"],
    live: values.live === true,
  };
}

async function readState(path: string) {
  try {
    return savedStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function saveState(path: string, state: SavedState) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function claimStateFile(lock: string) {
  const write = () => writeFile(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  try {
    await write();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const recovery = `${lock}.recovery`;
    await writeFile(recovery, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    try {
      const owner = z.coerce
        .number()
        .int()
        .positive()
        .parse((await readFile(lock, "utf8")).trim());
      try {
        process.kill(owner, 0);
      } catch (probe) {
        if (errorCode(probe) !== "ESRCH") throw probe;
        await unlink(lock);
        await write();
        return;
      }
      throw new Error("Another qualification process owns this state file.");
    } finally {
      await unlink(recovery);
    }
  }
}

async function loadLocalContext(
  { workdir, statusPath }: Pick<ReturnType<typeof commandArguments>, "workdir" | "statusPath">,
  runId: string,
): Promise<ImprovementLoopContext> {
  if (statusPath && ((await stat(statusPath)).mode & 0o077) !== 0) {
    throw new Error("The local status file includes credentials and must be private to its owner.");
  }
  const rawStatus = statusPath
    ? await readFile(statusPath, "utf8")
    : execFileSync("supabase", ["status", "--workdir", workdir ?? "", "--output", "json"], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      });
  const config = statusSchema.parse(JSON.parse(rawStatus));
  const apiUrl = loopbackQualificationUrl(config.API_URL, ["http:"]).origin;
  const dbUrl = loopbackQualificationUrl(config.DB_URL, ["postgresql:", "postgres:"]).toString();
  improvementQualificationDatabaseEnvironment(dbUrl);
  process.env.NEXT_PUBLIC_SUPABASE_URL = apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = config.ANON_KEY;
  process.env.SUPABASE_SECRET_KEY = config.SERVICE_ROLE_KEY;
  return {
    apiUrl,
    dbUrl,
    runId,
    anonymousKey: config.ANON_KEY,
    jwtSecret: config.JWT_SECRET,
    admin: createClient<Database>(apiUrl, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

async function withLoopbackContinuity<T>(
  context: ImprovementLoopContext,
  verify: () => Promise<T>,
) {
  async function current() {
    const { data, error } = await context.admin.rpc("get_git_continuity_release_state");
    if (error || !data[0]) throw new Error("Could not read the isolated continuity gate.");
    return data[0];
  }
  async function set(enabled: boolean, revision: number) {
    const { data, error } = await context.admin.rpc("set_git_continuity_release", {
      p_enabled: enabled,
      p_expected_revision: revision,
      p_reason: "Isolated M10 improvement qualification",
    });
    if (error || data[0]?.enabled !== enabled)
      throw new Error("The isolated continuity gate changed unexpectedly.");
  }
  const initial = await current();
  if (!initial.enabled) await set(true, initial.revision);
  try {
    return await verify();
  } finally {
    if (!initial.enabled) await set(false, (await current()).revision);
  }
}

async function run() {
  const args = commandArguments();
  const lockPath = `${args.statePath}.lock`;
  await claimStateFile(lockPath);
  try {
    const previous = await readState(args.statePath);
    if (args.command === "prepare") {
      if (previous)
        throw new Error("Use a fresh state file for preparation. Use publish with prepared state.");
      if (!args.appOrigin) throw new Error("Provide the loopback Wallie application origin.");
      const appOrigin = loopbackQualificationUrl(args.appOrigin, ["http:"]).origin;
      const local = await loadLocalContext(args, randomUUID());
      const context = args.live
        ? { ...local, githubInstallation: await readImprovementLoopGitHubInstallation() }
        : local;
      await saveState(args.statePath, { preparing: true, runId: context.runId });
      const prepared = await withLoopbackContinuity(context, async () => {
        const { baseline, candidate, ...source } = await prepareImprovementLoopSource(context);
        const validation = await qualifyImprovementLoopValidation(context, {
          ...source,
          baseline,
          candidate,
        });
        return improvementLoopPreparedSchema.parse({
          ...source,
          ...validation,
          appOrigin,
          runId: context.runId,
          baseline: {
            activationNumber: baseline.activationNumber,
            revisionId: baseline.revisionId,
            digest: baseline.digest,
          },
          candidate: { revisionId: candidate.revisionId, digest: candidate.digest },
        });
      });
      await saveState(args.statePath, {
        ...prepared,
        installationId: context.githubInstallation?.id ?? null,
      });
      console.info(
        JSON.stringify({
          status: "qualified",
          cohort: prepared.cohortId,
          proposalRevision: prepared.proposalRevisionId,
          validation: prepared.validationId,
        }),
      );
      return;
    }

    if (!previous || "preparing" in previous)
      throw new Error("Prepare the qualification fixture before publishing.");
    if ("publication" in previous) {
      console.info(
        JSON.stringify({ status: "publication-recorded", pullRequest: previous.publication.url }),
      );
      return;
    }
    const { baseProof, installationId, ...fixture } = previous;
    if (installationId === null)
      throw new Error(
        "Use prepare --live with a fresh state file and a connected GitHub App before publishing.",
      );
    const context = await loadLocalContext(args, fixture.runId);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await authenticateQualificationOwner(page, fixture);
      const publication = await publishImprovementLoop({
        context,
        fixture,
        browser: page.request,
        installationId,
        baseProof,
        saveBase: (proof) =>
          saveState(args.statePath, { ...fixture, installationId, baseProof: proof }),
      });
      if (!publication) {
        console.info(JSON.stringify({ status: "publication-pending", runId: fixture.runId }));
        return;
      }
      await saveState(args.statePath, publication);
      console.info(
        JSON.stringify({
          status: "awaiting-human-review",
          pullRequest: publication.publication.url,
          head: publication.publication.headCommitSha,
        }),
      );
    } finally {
      await browser.close();
    }
  } finally {
    await unlink(lockPath);
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Improvement qualification failed.");
  process.exitCode = 1;
});
