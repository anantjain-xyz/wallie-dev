import { z } from "zod";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const dimensionSchema = z.enum(["passed", "checking", "blocked", "unknown"]);
const blockerSchema = z
  .object({
    code: z.string().min(1).max(200),
    requirement: z.string().min(1).max(200).optional(),
  })
  .strict();

const evidenceRecordSchema = z.object({
  key: z.string().min(1).max(200),
  command: z.string(),
  provenance: z.literal("harness"),
  status: z.enum(["passed", "failed", "stale", "error"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  commitSha: shaSchema.nullable(),
  treeSha: shaSchema.nullable(),
  finalCommitSha: shaSchema.nullable(),
  finalTreeSha: shaSchema.nullable(),
  reportKeys: z.array(z.string().max(200)).max(100),
  missingRequiredReports: z.array(z.string().max(200)).max(100),
});

export const reviewEvidenceDeliverySchema = z.object({
  requirements: deliveryRequirementsSchema,
  policyRevisionId: z.string().uuid(),
  finalStage: z.boolean(),
  approvalGated: z.boolean(),
  observationStale: z.boolean(),
  evaluation: z.object({
    state: z.enum(["unknown", "checking", "blocked", "ready", "merged", "closed"]),
    blockers: z.array(blockerSchema).max(64),
    dimensions: z.object({
      githubAccess: dimensionSchema,
      identity: dimensionSchema,
      checks: dimensionSchema,
      reviews: dimensionSchema,
      threads: dimensionSchema,
      evidence: dimensionSchema,
      mergeability: dimensionSchema,
    }),
    summary: z
      .object({
        githubAccess: z.literal("available"),
        checks: z.literal("passed"),
        reviews: z.literal("passed"),
        evidence: z.literal("passed"),
        threads: z.literal("passed"),
      })
      .nullable(),
  }),
  pr: z
    .object({
      repositoryFullName: z.string().max(200).nullable(),
      repositoryUrl: z.string().url().nullable(),
      number: z.number().int().positive().safe().nullable(),
      url: z.string().url().nullable(),
      state: z.enum(["open", "closed", "merged"]).nullable(),
      draft: z.boolean().nullable(),
      headSha: shaSchema.nullable(),
      baseSha: shaSchema.nullable(),
      observedAt: z.string().datetime({ offset: true }).nullable(),
    })
    .nullable(),
  checks: z
    .array(
      z.object({
        context: z.string().min(1).max(200),
        appId: z.number().int().safe().nullable(),
        sources: z
          .array(z.enum(["policy", "ruleset", "branch_protection"]))
          .min(1)
          .max(3),
        status: z.enum(["passed", "pending", "failed", "missing", "stale", "unknown"]),
      }),
    )
    .max(100),
  review: z
    .object({
      decision: z.string().max(100).nullable(),
      currentHeadApprovals: z.number().int().nonnegative(),
      minimumApprovals: z.number().int().nonnegative(),
      codeOwnersRequired: z.boolean(),
      requireResolvedThreads: z.boolean(),
      unresolvedThreads: z.number().int().nonnegative(),
      mergeStateStatus: z.string().max(100).nullable(),
      protection: z.enum(["verified", "unknown"]),
    })
    .nullable(),
  evidence: z
    .object({
      runId: z.string().uuid().nullable(),
      commitSha: shaSchema.nullable(),
      validationTreeSha: shaSchema.nullable(),
      createdAt: z.string().datetime({ offset: true }).nullable(),
      required: z
        .array(
          z.object({
            key: z.string().min(1).max(200),
            status: z.enum(["passed", "missing", "stale", "failed", "unavailable"]),
          }),
        )
        .max(100),
      records: z.array(evidenceRecordSchema).max(100),
      assets: z
        .array(
          z.object({
            id: z.string().uuid(),
            key: z.string().min(1).max(200),
            kind: z.enum(["report", "screenshot", "preview", "log"]),
            required: z.boolean(),
            sizeBytes: z.number().int().nonnegative(),
            downloadUrl: z.string().startsWith("/api/sessions/"),
          }),
        )
        .max(100),
    })
    .nullable(),
  artifactBlockingCount: z.number().int().nonnegative(),
  refresh: z.object({
    status: z.enum(["current", "pending", "claimed", "error"]).nullable(),
    lastErrorCode: z.string().max(100).nullable(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    canRefresh: z.boolean(),
  }),
  sourceObservationId: z.string().uuid().nullable(),
});

export const reviewEvidenceResponseSchema = z
  .object({ delivery: reviewEvidenceDeliverySchema.nullable() })
  .strict();

export const prDiffFileSchema = z.object({
  filename: z.string().min(1).max(1000),
  previousFilename: z.string().min(1).max(1000).nullable(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullable(),
  patchTruncated: z.boolean(),
  patchUnavailable: z.boolean(),
  blobUrl: z.string().url().nullable(),
});

export const prDiffSchema = z.object({
  repositoryFullName: z.string().max(200),
  prNumber: z.number().int().positive().safe(),
  url: z.string().url(),
  headSha: shaSchema,
  baseSha: shaSchema,
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  files: z.array(prDiffFileSchema).max(100),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
  limits: z.object({
    maxFiles: z.number().int().positive(),
    maxPatchLines: z.number().int().positive(),
    maxPatchCharacters: z.number().int().positive(),
  }),
});

export const prDiffResponseSchema = z.object({ diff: prDiffSchema }).strict();

export type ReviewEvidenceDelivery = z.infer<typeof reviewEvidenceDeliverySchema>;
export type ReviewEvidenceResponse = z.infer<typeof reviewEvidenceResponseSchema>;
export type PrDiff = z.infer<typeof prDiffSchema>;
export type PrDiffFile = z.infer<typeof prDiffFileSchema>;
export type PrDiffResponse = z.infer<typeof prDiffResponseSchema>;
