import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

import { evaluationReceiptRecordSchema } from "./evaluation-receipt-contracts";

const id = z.string().uuid();
const expectedRevision = z.number().int().min(0).max(2_147_483_647);
const positiveRevision = expectedRevision.min(1);
const timestamp = z.string().datetime({ offset: true });
export const adjudicationDisposition = z.enum(["confirmed", "disputed"]);
export const adjudicationOutcome = z.enum(["pass", "fail", "inconclusive"]);
const boundedText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= limit && isFactoryDefinitionText(value));
const note = boundedText(640);
const name = boundedText(120);
const caseIds = z
  .array(id)
  .min(1)
  .max(40)
  .refine((ids) => new Set(ids.map((value) => value.toLowerCase())).size === ids.length);

export const scorerGovernanceCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pause"), expectedRevision, paused: z.boolean() }),
  z.strictObject({
    action: z.literal("calibration"),
    setId: id,
    expectedRevision,
    scorerRevisionId: id,
    name,
    adjudicationIds: caseIds,
  }),
]);
export type ScorerGovernanceCommand = z.output<typeof scorerGovernanceCommandSchema>;

export const evaluationGovernanceCommandSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("adjudicate"),
      adjudicationId: id,
      disposition: adjudicationDisposition,
      note,
      expectedStatus: adjudicationOutcome.optional(),
    }),
    z.strictObject({ action: z.literal("reevaluate"), targetRevisionId: id }),
  ])
  .refine(
    (command) =>
      command.action !== "adjudicate" ||
      command.disposition === "disputed" ||
      !command.expectedStatus,
  );
export type EvaluationGovernanceCommand = z.output<typeof evaluationGovernanceCommandSchema>;

export const scorerPauseSchema = z.object({
  paused: z.boolean(),
  revision: expectedRevision,
  updated_at: timestamp.nullable(),
});
export type ScorerPause = z.output<typeof scorerPauseSchema>;

const adjudicationFields = {
  id,
  attempt_id: id,
  disposition: adjudicationDisposition,
  expected_status: adjudicationOutcome.nullable(),
  note: note.nullable(),
  created_at: timestamp,
};
export const scorerAdjudicationSchema = z.object(adjudicationFields);
export const evaluationReviewSchema = z.object({
  can_adjudicate: z.boolean(),
  adjudications: z.array(scorerAdjudicationSchema).max(20),
  has_more: z.boolean(),
  next_before_created_at: timestamp.nullable(),
  next_before_adjudication_id: id.nullable(),
});
export type EvaluationReview = z.output<typeof evaluationReviewSchema>;

export const scorerCalibrationRevisionSchema = z
  .object({
    id,
    set_id: id,
    revision: positiveRevision,
    name,
    scorer_revision_id: id,
    scorer_revision_number: positiveRevision,
    adjudication_ids: caseIds,
    case_refs: z.array(z.object({ adjudication_id: id, attempt_id: id, run_id: id })).max(40),
    created_at: timestamp,
  })
  .refine(
    (version) =>
      version.case_refs.length === version.adjudication_ids.length &&
      version.case_refs.every(
        (reference, index) => reference.adjudication_id === version.adjudication_ids[index],
      ),
  );
export type CalibrationRevision = z.output<typeof scorerCalibrationRevisionSchema>;

const candidatePageFields = {
  candidates: z
    .array(
      z.object({
        ...adjudicationFields,
        status: z.enum(["pass", "fail", "inconclusive", "skipped", "error"]),
        reason: z.string().max(80).nullable(),
      }),
    )
    .max(40),
  next_before_candidate_at: timestamp.nullable(),
  next_before_candidate_id: id.nullable(),
};

export const calibrationCandidateCursorSchema = z.strictObject({
  beforeCandidateAt: timestamp,
  beforeCandidateId: id.transform((value) => value.toLowerCase()),
});

export const calibrationCandidatePageSchema = z
  .object(candidatePageFields)
  .refine(
    (page) => (page.next_before_candidate_at === null) === (page.next_before_candidate_id === null),
  );
export type CalibrationCandidatePage = z.output<typeof calibrationCandidatePageSchema>;

export const scorerCalibrationSchema = z
  .object({
    versions: z.array(scorerCalibrationRevisionSchema).max(20),
    ...candidatePageFields,
    next_before_revision: positiveRevision.nullable(),
    next_before_set_at: timestamp.nullable(),
    next_before_set_id: id.nullable(),
  })
  .refine(
    (page) =>
      (page.next_before_set_at === null) === (page.next_before_set_id === null) &&
      (page.next_before_candidate_at === null) === (page.next_before_candidate_id === null),
  );
export type ScorerCalibration = z.output<typeof scorerCalibrationSchema>;

const reevaluationFields = {
  job_id: id,
  prior_attempt_id: id,
  target_scorer_revision_id: id,
  status: z.enum(["queued", "claimed", "succeeded", "failed", "canceled"]),
};
export const scorerReevaluationSchema = z.object(reevaluationFields);
export const scorerReevaluationsSchema = z
  .object({
    jobs: z
      .array(z.object({ ...reevaluationFields, receipt: evaluationReceiptRecordSchema.nullable() }))
      .max(32),
    next_before_created_at: timestamp.nullable(),
    next_before_job_id: id.nullable(),
  })
  .refine((page) => (page.next_before_created_at === null) === (page.next_before_job_id === null));
export type ScorerReevaluations = z.output<typeof scorerReevaluationsSchema>;

export const scorerGovernanceResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), pause: scorerPauseSchema }),
  z.object({ action: z.literal("calibration"), calibration: scorerCalibrationRevisionSchema }),
]);

export const evaluationGovernanceResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("adjudicate"), adjudication: scorerAdjudicationSchema }),
  z.object({ action: z.literal("reevaluate"), reevaluation: scorerReevaluationSchema }),
]);
