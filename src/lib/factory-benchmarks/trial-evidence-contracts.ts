import { z } from "zod";

import { factoryScorerScoreSchema } from "@/lib/factory-scorers/result";
import { Constants } from "@/lib/supabase/database.types";

import { benchmarkComparisonIdSchema as id } from "./comparison-contracts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pos = z.number().int().positive();
const availability = z.enum(["available", "withheld", "unavailable"]);
const owner = z.strictObject({
  sessionId: id,
  runId: id,
  jobId: id,
  attemptCount: pos,
  runStatus: z.enum(Constants.public.Enums.agent_run_status),
  commitSha: sha.nullable(),
  treeSha: sha.nullable(),
});
const evidenceSide = z.strictObject({
  availability,
  owner: owner.nullable(),
  mediaPlanMatched: z.boolean(),
  transcriptExpiredAt: z.string().datetime({ offset: true }).nullable(),
});
const revision = z.strictObject({ id, revisionId: id, revisionNumber: pos, name: z.string() });
const scoreStatus = z.enum([
  "pending",
  "pass",
  "fail",
  "inconclusive",
  "skipped",
  "error",
  "unavailable",
]);
const location = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whole") }),
  z.strictObject({ kind: z.literal("lines"), startLine: pos, endLine: pos }),
]);

export const trialEvidenceIdParamsSchema = z.object({
  workspaceId: id,
  factoryId: id,
  experimentId: id,
  trialId: id,
});
export const trialEvidenceMediaSideSchema = z.enum(["original", "output"]);
export type TrialEvidenceMediaSide = z.infer<typeof trialEvidenceMediaSideSchema>;

export const benchmarkTrialEvidenceSchema = z.strictObject({
  workspaceId: id,
  factoryId: id,
  experimentId: id,
  suite: revision,
  trial: z.strictObject({
    id,
    repetition: pos,
    seed: z.number().int().nonnegative(),
    timeoutMs: pos,
    eligibility: z.enum(["eligible", "ineligible", "unverified"]),
    eligibilityReason: z.string().nullable(),
    status: z.enum([
      "excluded",
      "pending",
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "canceled",
      "unavailable",
    ]),
    reason: z.string().nullable(),
    admitted: z.boolean(),
    started: z.boolean(),
  }),
  task: revision.extend({
    acceptanceCriteria: z.string().max(20_000).nullable(),
    acceptanceTruncated: z.boolean(),
    tags: z.array(z.string()).max(25),
  }),
  candidate: z.strictObject({
    key: digest,
    position: pos.nullable(),
    definitionRevisionId: id,
    definitionDigest: digest,
    harness: z.string(),
    model: z.string(),
    workerRuntime: z.string(),
    sandboxProvider: z.string(),
  }),
  frozenInputs: z.strictObject({
    policyRevisionId: id,
    policyDigest: digest,
    checkoutSha: sha.nullable(),
    inputSha: sha.nullable(),
    sourceDefinitionRevisionId: id.nullable(),
    sourceDefinitionDigest: digest.nullable(),
    contextManifestSha256: digest.nullable(),
  }),
  source: evidenceSide,
  output: evidenceSide.extend({
    inputCommitSha: sha.nullable(),
    inputTreeSha: sha.nullable(),
    resultDigest: digest.nullable(),
    validation: z
      .strictObject({
        key: z.string(),
        status: z.string(),
        commitSha: sha,
        treeSha: sha,
      })
      .nullable(),
  }),
  diff: z.strictObject({
    availability,
    patch: z.string().max(65_536).nullable(),
    sha256: digest.nullable(),
  }),
  scores: z
    .array(
      z.strictObject({
        scorerRevisionId: id,
        scorerId: id,
        name: z.string(),
        revisionNumber: pos,
        status: scoreStatus,
        reason: z.string().nullable(),
        score: factoryScorerScoreSchema.nullable(),
        explanation: z.string().max(640).nullable(),
        evidenceAvailability: availability,
        evidenceLocations: z
          .array(
            z.strictObject({
              kind: z.enum(["artifact", "validation_report"]),
              location,
            }),
          )
          .max(5),
      }),
    )
    .max(16),
});

export type BenchmarkTrialEvidence = z.infer<typeof benchmarkTrialEvidenceSchema>;
export type BenchmarkTrialEvidenceOwner = z.infer<typeof owner>;
