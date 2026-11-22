import { readFile } from "node:fs/promises";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "../../src/lib/supabase/database.types";

export type ImprovementLoopContext = {
  admin: SupabaseClient<Database>;
  apiUrl: string;
  dbUrl: string;
  anonymousKey: string;
  jwtSecret: string;
  runId: string;
  githubInstallation?: ImprovementLoopGitHubInstallation;
};

export type ImprovementLoopGitHubInstallation = {
  id: number;
  appId: number;
  url: string;
  targetType: string;
  owner: string;
};

export const improvementQualificationRepository = "anantjain-xyz/wallie-dev";
export const improvementQualificationRepositoryId = 1196742316;
export const improvementQualificationInstallationSlot = 40;

export function improvementQualificationFixtureId(runId: string, slot: number) {
  return `${runId.slice(0, -4)}${slot.toString(16).padStart(4, "0")}`;
}

export function loopbackQualificationUrl(value: string, protocols: readonly string[]) {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Improvement qualification requires a disposable loopback project.");
  }
  return url;
}

export function improvementQualificationDatabaseEnvironment(value: string): NodeJS.ProcessEnv {
  const database = loopbackQualificationUrl(value, ["postgresql:", "postgres:"]);
  const socket = database.searchParams.get("host");
  if (
    !database.username ||
    !/^\/[A-Za-z0-9_]+$/.test(database.pathname) ||
    database.hash ||
    [...database.searchParams.keys()].some((key) => key !== "host") ||
    (socket !== null && !/^\/(?:private\/)?tmp\/wallie-[A-Za-z0-9_.-]+\/socket$/.test(socket))
  ) {
    throw new Error("Use a dedicated local PostgreSQL port or private fixture socket.");
  }
  return {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    PGHOST: socket ?? database.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: database.port || "5432",
    PGDATABASE: database.pathname.slice(1),
    PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password),
    PGCONNECT_TIMEOUT: "5",
  };
}

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positiveInteger = z.number().int().positive().safe();
const appOrigin = z
  .string()
  .url()
  .refine((value) => {
    try {
      return loopbackQualificationUrl(value, ["http:"]).origin === value;
    } catch {
      return false;
    }
  });

const candidateSchema = z.object({ revisionId: uuid, digest }).strict();
const baselineSchema = candidateSchema.extend({ activationNumber: positiveInteger });

const sourceSchema = z.object({
  workspaceId: uuid,
  workspaceSlug: z.string().min(1),
  factoryId: uuid,
  actorUserId: uuid,
  ownerEmail: z.string().email(),
  cohortId: uuid,
  diagnosisId: uuid,
  proposalId: uuid,
  proposalRevisionId: uuid,
  sourceRunIds: z
    .array(uuid)
    .min(3)
    .refine((ids) => new Set(ids).size === ids.length),
  baseline: baselineSchema,
  candidate: candidateSchema,
});

export type ImprovementLoopSource = Omit<
  z.output<typeof sourceSchema>,
  "baseline" | "candidate"
> & {
  baseline: z.output<typeof baselineSchema> & { definitionJson: string };
  candidate: z.output<typeof candidateSchema> & { definitionJson: string };
};

const validationSchema = z.object({
  validationId: uuid,
  targetedExperimentId: uuid,
  holdoutExperimentId: uuid,
});

export type ImprovementLoopValidation = z.output<typeof validationSchema>;

export const improvementLoopPreparedSchema = sourceSchema
  .merge(validationSchema)
  .extend({ runId: uuid, appOrigin })
  .strict();

export type ImprovementLoopPrepared = z.output<typeof improvementLoopPreparedSchema>;

export function improvementQualificationBase(runId: string) {
  return `wallie/improvement-smoke/${runId}/base`;
}

const publicationSchema = z
  .object({
    id: uuid,
    number: positiveInteger,
    url: z.string().url(),
    baseBranch: z.string(),
    headBranch: z.string(),
    baseCommitSha: sha,
    headCommitSha: sha,
    repositoryNumericId: z.literal(improvementQualificationRepositoryId),
    configPath: z.string(),
  })
  .strict();

export const factoryImprovementLoopManifestSchema = improvementLoopPreparedSchema
  .extend({ publication: publicationSchema })
  .refine(({ runId, factoryId, proposalRevisionId, publication }) => {
    return (
      publication.url ===
        `https://github.com/${improvementQualificationRepository}/pull/${publication.number}` &&
      publication.baseBranch === improvementQualificationBase(runId) &&
      publication.headBranch === `wallie/improvements/${factoryId}/${proposalRevisionId}` &&
      publication.baseCommitSha !== publication.headCommitSha &&
      publication.configPath === `.wallie/factory-definitions/${factoryId}.json`
    );
  }, "The publication must match this exact disposable repository scope.");

export type FactoryImprovementLoopManifest = z.output<typeof factoryImprovementLoopManifestSchema>;

export async function readFactoryImprovementLoopManifest(path: string) {
  const body: unknown = JSON.parse(await readFile(path, "utf8"));
  return factoryImprovementLoopManifestSchema.parse(body);
}
