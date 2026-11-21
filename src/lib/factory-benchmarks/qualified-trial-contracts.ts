import { z } from "zod";

import { replayCommitSchema, replayDigestSchema } from "./replay-contracts";

export const QUALIFIED_BENCHMARK_RUNNER = "openai-responses-v1";
export const QUALIFIED_PROMPT_RENDERER_VERSION = 1;

const uuid = z.string().uuid();
const worker = z.enum(["node", "workerd"]);
const modelSnapshot = /^gpt-[a-z0-9.-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export const qualifiedTrialIdentitySchema = z.object({
  trialId: uuid,
  jobId: uuid,
  runId: uuid,
  workspaceId: uuid,
  factoryId: uuid,
  sessionId: uuid,
  actorUserId: uuid,
  attemptCount: z.literal(1),
});

export const qualifiedTrialClaimSchema = z
  .object({
    runnerRevision: z.literal(QUALIFIED_BENCHMARK_RUNNER),
    identity: qualifiedTrialIdentitySchema,
    deadlineAt: z.string().datetime({ offset: true }),
    taskRevisionId: uuid,
    policyRevisionId: uuid,
    policyDigest: replayDigestSchema,
    workerRuntime: worker,
    sandboxConnectionRevision: uuid,
    inferenceConnectionRevision: uuid,
    candidate: z.object({
      definitionRevisionId: uuid,
      definitionDigest: replayDigestSchema,
      effectiveExecutionDigest: replayDigestSchema,
      qualificationId: uuid,
      harness: z.enum(["codex", "opencode"]),
      nativeModel: z.string().min(1).max(200),
      upstreamModel: z.string().max(200).regex(modelSnapshot),
      toolchain: z.object({
        image: z
          .string()
          .max(300)
          .regex(/^vcr\.vercel\.com\/[A-Za-z0-9/_.-]+@sha256:[a-f0-9]{64}$/),
        cliVersion: z
          .string()
          .max(64)
          .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
        cliDigest: replayDigestSchema,
      }),
    }),
  })
  .refine(
    ({ candidate }) =>
      candidate.nativeModel ===
      (candidate.harness === "codex"
        ? candidate.upstreamModel
        : `openai/${candidate.upstreamModel}`),
  );

export type QualifiedTrialClaim = z.infer<typeof qualifiedTrialClaimSchema>;
export type QualifiedTrialIdentity = z.infer<typeof qualifiedTrialIdentitySchema>;

export const qualifiedSandboxBindingSchema = z.object({
  signedSandboxId: z.string().min(1).max(256),
});
export const qualifiedInferenceReceiptSchema = z.object({
  inferenceReceiptId: uuid,
  observedModel: z.string().max(200).regex(modelSnapshot),
});

export const qualifiedTrialResultSchema = z.object({
  input: z.object({
    restorationReceiptSha256: replayDigestSchema,
    inputBundleSha256: replayDigestSchema,
    commitSha: replayCommitSchema,
    treeSha: replayCommitSchema,
    replayPromptSha256: replayDigestSchema,
    rendererRevision: z.literal(QUALIFIED_PROMPT_RENDERER_VERSION),
  }),
  output: z.object({
    artifactMarkdown: z
      .string()
      .min(1)
      .refine((artifact) => Buffer.byteLength(artifact, "utf8") <= 256 * 1024),
    commitSha: replayCommitSchema,
    treeSha: replayCommitSchema,
    validation: z.object({
      version: z.literal(1),
      key: z.literal("qualified-replay-source"),
      status: z.literal("passed"),
      commitSha: replayCommitSchema,
      treeSha: replayCommitSchema,
    }),
    checkpoint: z.object({
      kind: z.literal("bundle"),
      sha256: replayDigestSchema,
      storagePath: z.string().min(1).max(512),
      uploadOperationId: uuid,
    }),
  }),
  inferenceReceiptId: uuid,
});

export type QualifiedTrialResult = z.infer<typeof qualifiedTrialResultSchema>;
