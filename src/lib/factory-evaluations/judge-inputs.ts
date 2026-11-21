import { z } from "zod/v4";

const id = z.uuid();
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative();

export const factoryJudgeProfileRowSchema = z.object({
  id,
  workspace_id: id,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  provider: z.literal("openrouter"),
  model_id: z.string(),
  provider_route: z.string(),
  allow_images: z.boolean(),
  allow_video: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
});

export const factoryJudgeClaimSchema = z.object({
  job_id: id,
  workspace_id: id,
  factory_id: id,
  session_id: id,
  run_id: id,
  scorer_revision_id: id,
  sample_receipt_id: id,
  target_commit_sha: commitSha,
  attempt_id: id,
  attempt_number: z.number().int().positive(),
  lease_id: id,
  lease_expires_at: z.iso.datetime({ offset: true }),
});
export type FactoryJudgeClaim = z.output<typeof factoryJudgeClaimSchema>;

const privateAsset = {
  id,
  workspace_id: id,
  session_id: id,
  run_id: id,
  storage_path: z.string().max(500),
  sha256,
  size_bytes: natural,
};
const evidence = z.union([
  z.object({
    kind: z.literal("code_diff"),
    id,
    input_sha: commitSha,
    output_sha: commitSha,
    repository_id: id,
    repository_full_name: z.string().max(300),
    github_repository_id: z.number().int().positive().nullable(),
    installation_id: z.number().int().positive().nullable(),
  }),
  z.object({ kind: z.literal("artifact"), id, content_md: z.string() }),
  z.object({
    kind: z.literal("validation_report"),
    ...privateAsset,
    content_type: z.enum(["text/plain", "application/json"]),
  }),
  z.object({
    kind: z.literal("validation_report"),
    id,
    source: z.literal("benchmark_result"),
    content_text: z.string(),
    sha256,
  }),
  z.object({
    kind: z.literal("browser_screenshot"),
    ...privateAsset,
    content_type: z.literal("image/png"),
  }),
  z.object({
    kind: z.literal("browser_recording"),
    ...privateAsset,
    content_type: z.literal("video/webm"),
    duration_ms: natural,
    width_px: natural,
    height_px: natural,
    frame_offsets_ms: z.array(natural),
    capture_started_at: z.iso.datetime({ offset: true }),
    capture_completed_at: z.iso.datetime({ offset: true }),
  }),
]);
export type FactoryJudgeEvidenceDescriptor = z.output<typeof evidence>;

const preflightStatus = z.enum([
  "stale_claim",
  "profile_unavailable",
  "evidence_unavailable",
  "missing_evidence",
  "unsupported_evidence",
  "already_started",
]);

const benchmarkBlocked = z.object({
  status: z.literal("benchmark_blocked"),
  reason: z.enum([
    "schedule_paused",
    "schedule_canceled",
    "evaluation_budget_exhausted",
    "evaluation_budget_wait",
  ]),
});

export const factoryJudgePreparationSchema = z.union([
  z.object({
    status: z.literal("ready"),
    profile: factoryJudgeProfileRowSchema,
    definition: z.unknown(),
    sample_receipt_id: id,
    scorer_revision_id: id,
    target_commit_sha: commitSha,
    session_id: id,
    run_id: id,
    evidence: z.array(evidence).min(1).max(5),
    benchmark_source: z.object({ trial_id: id, result_digest: sha256 }).optional(),
  }),
  benchmarkBlocked,
  z.object({ status: preflightStatus }),
]);
export const factoryJudgePermitSchema = z.union([
  z.object({ status: z.literal("authorized"), encrypted_api_key: z.string().min(1).max(8192) }),
  benchmarkBlocked,
  z.object({ status: preflightStatus }),
]);
