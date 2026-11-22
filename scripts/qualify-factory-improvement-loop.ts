import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { authenticateQualificationOwner } from "../e2e/helpers/factory-improvement-loop-qualification";
import type { Database } from "../src/lib/supabase/database.types";
import {
  claimImprovementQualificationStateFile,
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
const pausedContinuitySchema = z.strictObject({
  revision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 2),
  reason: z.string().min(1),
});
const preparingSchema = z.strictObject({
  preparing: z.literal(true),
  runId: z.string().uuid(),
  pausedContinuity: pausedContinuitySchema.optional(),
});
type PreparingState = z.output<typeof preparingSchema>;
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
      "Use prepare or publish with --state and either --workdir or a private local --status-file. Fresh preparation also needs --app-origin.",
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

const legacyContinuityReason = "Isolated M10 improvement qualification";
const continuityReasonPrefix = `${legacyContinuityReason} run `;

async function readContinuity(context: ImprovementLoopContext) {
  const { data, error } = await context.admin.rpc("get_git_continuity_release_state");
  if (error || !data[0]) throw new Error("Could not read the isolated continuity gate.");
  return data[0];
}

async function setContinuity(
  context: ImprovementLoopContext,
  enabled: boolean,
  revision: number,
  reason: string,
) {
  const { data, error } = await context.admin.rpc("set_git_continuity_release", {
    p_enabled: enabled,
    p_expected_revision: revision,
    p_reason: reason,
  });
  const updated = data?.[0];
  if (
    error ||
    updated?.enabled !== enabled ||
    updated.revision !== revision + 1 ||
    updated.reason !== reason
  ) {
    throw new Error("The isolated continuity gate changed unexpectedly.");
  }
}

async function restoreOwnedContinuity(context: ImprovementLoopContext, state: PreparingState) {
  if (!state.pausedContinuity) return false;
  const gate = await readContinuity(context);
  const ownedRevision = state.pausedContinuity.revision + 1;
  if (
    !gate.enabled ||
    gate.revision !== ownedRevision ||
    gate.reason !== `${continuityReasonPrefix}${state.runId}`
  ) {
    return false;
  }
  await setContinuity(context, false, ownedRevision, state.pausedContinuity.reason);
  return true;
}

async function run() {
  const args = commandArguments();
  const lock = await claimImprovementQualificationStateFile(args.statePath);
  try {
    const previous = await readState(args.statePath);
    if (args.command === "prepare") {
      if (previous && "preparing" in previous) {
        const restored = previous.pausedContinuity
          ? await restoreOwnedContinuity(await loadLocalContext(args, previous.runId), previous)
          : false;
        const result = restored
          ? "Restored the continuity gate to its prior paused state."
          : "This saved preparation owns no current continuity change.";
        throw new Error(`${result} Start a fresh disposable fixture scope with a new state file.`);
      }
      if (previous)
        throw new Error("Use a fresh state file for preparation. Use publish with prepared state.");
      if (!args.appOrigin) throw new Error("Provide the loopback Wallie application origin.");
      const appOrigin = loopbackQualificationUrl(args.appOrigin, ["http:"]).origin;
      const local = await loadLocalContext(args, randomUUID());
      const initial = await readContinuity(local);
      if (
        initial.enabled &&
        (initial.reason === legacyContinuityReason ||
          initial.reason.startsWith(continuityReasonPrefix))
      ) {
        throw new Error(
          "The continuity gate belongs to another qualification run. Recover its saved state or use a fresh disposable fixture database.",
        );
      }
      const context = args.live
        ? { ...local, githubInstallation: await readImprovementLoopGitHubInstallation() }
        : local;
      const preparing = preparingSchema.parse({
        preparing: true,
        runId: context.runId,
        pausedContinuity: initial.enabled
          ? undefined
          : { revision: initial.revision, reason: initial.reason },
      });
      await saveState(args.statePath, preparing);
      let prepared: z.output<typeof improvementLoopPreparedSchema>;
      try {
        if (preparing.pausedContinuity) {
          await setContinuity(
            context,
            true,
            preparing.pausedContinuity.revision,
            `${continuityReasonPrefix}${preparing.runId}`,
          );
        }
        const { baseline, candidate, ...source } = await prepareImprovementLoopSource(context);
        const validation = await qualifyImprovementLoopValidation(context, {
          ...source,
          baseline,
          candidate,
        });
        prepared = improvementLoopPreparedSchema.parse({
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
      } catch (error) {
        await restoreOwnedContinuity(context, preparing).catch(() => {
          console.error("Continuity cleanup failed. Rerun prepare with this state file.");
        });
        throw error;
      }
      if (preparing.pausedContinuity && !(await restoreOwnedContinuity(context, preparing))) {
        throw new Error("The qualification lost ownership of the continuity gate before cleanup.");
      }
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
      await saveState(args.statePath, publication.manifest);
      console.info(
        JSON.stringify({
          status: publication.merged ? "awaiting-adoption" : "awaiting-human-review",
          pullRequest: publication.manifest.publication.url,
          head: publication.manifest.publication.headCommitSha,
        }),
      );
    } finally {
      await browser.close();
    }
  } finally {
    await lock.close();
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Improvement qualification failed.");
  process.exitCode = 1;
});
